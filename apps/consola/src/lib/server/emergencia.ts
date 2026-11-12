/*
 * Entrada de emergencia con llave FIDO2/WebAuthn, para cuando Entra no
 * responde, no hay internet o el nodo aún no lo tiene configurado.
 *
 * Una llave se registra de dos maneras: un administrador con su sesión
 * normal, o con un código de un solo uso que solo puede sacar quien tiene
 * acceso a la máquina (scripts/emergencia.mjs). Entrar con ella da rol de
 * administrador y queda marcado en la auditoría y en la barra.
 */
import { createHash, randomBytes } from 'node:crypto';
import { almacenDeRetos } from './retos';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema as s } from './db';
import { auditar } from './consultas';

const VIDA_RETO = 5 * 60_000;
/* `alta`: el hash del código de alta con el que se pidió el reto, si fue así. Se gasta al registrar. */
type DatosReto = { reto: string; nombre?: string; quien?: string; alta?: string };
/* Pedir un reto de entrada no exige sesión: el almacén tiene tope (retos.ts). */
export const MAX_RETOS = 1000;
const retos = almacenDeRetos<DatosReto>(MAX_RETOS, VIDA_RETO);
const guardarReto = (datos: DatosReto) => retos.guardar(datos);
const tomarReto = (id: string | undefined) => retos.tomar(id);

export const llaves = () =>
	db
		.select({
			id: s.llavesEmergencia.id,
			nombre: s.llavesEmergencia.nombre,
			registradaPor: s.llavesEmergencia.registradaPor,
			creada: s.llavesEmergencia.creada,
			ultimoUso: s.llavesEmergencia.ultimoUso
		})
		.from(s.llavesEmergencia)
		.orderBy(s.llavesEmergencia.creada);

/* ---------- códigos de alta (solo con acceso a la máquina) ---------- */

const hash = (c: string) => createHash('sha256').update(c).digest('hex');

export async function codigoValido(codigo: string | null) {
	if (!codigo) return false;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'emergencia_alta'));
	const v = f?.valor as { hash: string; caduca: string } | undefined;
	return !!v && v.hash === hash(codigo) && Date.parse(v.caduca) > Date.now();
}

/*
 * Gasta el código de alta con el que se pidió el reto. Es un solo DELETE que
 * comprueba hash y caducidad: de dos registros en paralelo con el mismo
 * código solo uno lo consigue. false si ya se gastó, se cambió o caducó.
 */
async function gastarCodigo(hashCodigo: string) {
	const borradas = await db
		.delete(s.ajustes)
		.where(
			and(
				eq(s.ajustes.clave, 'emergencia_alta'),
				sql`${s.ajustes.valor}->>'hash' = ${hashCodigo}`,
				sql`(${s.ajustes.valor}->>'caduca')::timestamptz > now()`
			)
		)
		.returning({ clave: s.ajustes.clave });
	return borradas.length > 0;
}

/* Para las pruebas. */
export const _gastarCodigoAlta = (codigo: string) => gastarCodigo(hash(codigo));

/* ---------- registro ---------- */

/* `codigo`: el código de alta, ya comprobado, si quien registra no es un administrador. */
export async function opcionesRegistro(
	rpID: string,
	nombre: string,
	quien: string,
	codigo: string | null = null
) {
	const existentes = await llaves();
	const opciones = await generateRegistrationOptions({
		rpName: 'Sugardaddy',
		rpID,
		userName: `emergency · ${nombre}`,
		attestationType: 'none',
		excludeCredentials: existentes.map((l) => ({ id: l.id })),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }
	});
	return {
		opciones,
		reto: guardarReto({
			reto: opciones.challenge,
			nombre,
			quien,
			alta: codigo ? hash(codigo) : undefined
		})
	};
}

export async function registrar(
	retoId: string | undefined,
	respuesta: RegistrationResponseJSON,
	origen: string,
	rpID: string
) {
	const r = tomarReto(retoId);
	if (!r) return { ok: false as const, motivo: 'The challenge has expired. Start again.' };
	const conCodigo = !!r.alta;
	const v = await verifyRegistrationResponse({
		response: respuesta,
		expectedChallenge: r.reto,
		expectedOrigin: origen,
		expectedRPID: rpID,
		requireUserVerification: true
	}).catch((e: Error) => ({ verified: false as const, error: e.message }));
	if (!v.verified || !('registrationInfo' in v) || !v.registrationInfo)
		return { ok: false as const, motivo: 'The key did not pass verification.' };
	const { credential } = v.registrationInfo;
	/* El código vale para una sola llave: se gasta antes de guardarla. */
	if (r.alta && !(await gastarCodigo(r.alta)))
		return {
			ok: false as const,
			motivo: 'The enrollment code has already been used or has expired.'
		};
	await db.insert(s.llavesEmergencia).values({
		id: credential.id,
		clavePublica: Buffer.from(credential.publicKey).toString('base64'),
		contador: credential.counter,
		nombre: r.nombre!,
		registradaPor: r.quien!
	});
	await auditar(r.quien!, 'emergency key registered', { nombre: r.nombre, conCodigo });
	return { ok: true as const };
}

export async function retirarLlave(quien: string, id: string) {
	const [f] = await db.delete(s.llavesEmergencia).where(eq(s.llavesEmergencia.id, id)).returning();
	if (f) await auditar(quien, 'emergency key removed', { nombre: f.nombre });
	return !!f;
}

/* ---------- entrada ---------- */

export async function opcionesEntrada(rpID: string) {
	const existentes = await llaves();
	if (existentes.length === 0) return null;
	const opciones = await generateAuthenticationOptions({
		rpID,
		userVerification: 'required',
		allowCredentials: existentes.map((l) => ({ id: l.id }))
	});
	return { opciones, reto: guardarReto({ reto: opciones.challenge }) };
}

export async function verificarEntrada(
	retoId: string | undefined,
	respuesta: AuthenticationResponseJSON,
	origen: string,
	rpID: string
) {
	const r = tomarReto(retoId);
	if (!r) return null;
	const [llave] = await db
		.select()
		.from(s.llavesEmergencia)
		.where(eq(s.llavesEmergencia.id, respuesta.id));
	if (!llave) return null;
	const v = await verifyAuthenticationResponse({
		response: respuesta,
		expectedChallenge: r.reto,
		expectedOrigin: origen,
		expectedRPID: rpID,
		requireUserVerification: true,
		credential: {
			id: llave.id,
			publicKey: new Uint8Array(Buffer.from(llave.clavePublica, 'base64')),
			counter: llave.contador
		}
	}).catch(() => ({ verified: false as const }));
	if (!v.verified || !('authenticationInfo' in v)) return null;
	await db
		.update(s.llavesEmergencia)
		.set({ contador: v.authenticationInfo.newCounter, ultimoUso: new Date() })
		.where(eq(s.llavesEmergencia.id, llave.id));
	return llave;
}

/* ---------- código de emergencia (se crea al instalar) ---------- */

/*
 * La otra forma de entrar si todo falla: un código que el instalador enseña una
 * sola vez y el cliente guarda fuera de la máquina. Vale para entrar como
 * administrador una vez; al usarlo se cambia por otro, que se enseña en ese
 * momento. Tiene 120 bits de azar, así que basta con su sha256 (no hay nada que
 * adivinar por fuerza bruta) y el freno es solo para no llenar la auditoría.
 *
 * scripts/codigo-emergencia.mjs (el que usa el instalador) repite el formato y
 * el hash: si cambian aquí, cambian allí.
 */
const AJUSTE_CODIGO = 'emergencia_codigo';
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generarCodigoEmergencia() {
	const b = randomBytes(24);
	const c = Array.from(b, (x) => ALFABETO[x & 31]).join('');
	return c.match(/.{4}/g)!.join('-');
}

export const normalizarCodigo = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashCodigoEmergencia = (c: string) => hash(normalizarCodigo(c));

export async function estadoCodigoEmergencia() {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_CODIGO));
	const v = f?.valor as { creado: string; por: string } | undefined;
	return v ? { creado: v.creado, por: v.por } : null;
}

/* Crea (o sustituye) el código y lo devuelve en claro: es la única vez que se ve. */
export async function nuevoCodigoEmergencia(quien: string) {
	const codigo = generarCodigoEmergencia();
	const valor = {
		hash: hashCodigoEmergencia(codigo),
		creado: new Date().toISOString(),
		por: quien
	};
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE_CODIGO, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
	await auditar(quien, 'emergency code generated');
	return codigo;
}

/*
 * Solo por IP. Hubo también un tope de fallos entre todas las IP, pero lo
 * gastaba cualquiera sin tener ningún código y dejaba sin entrada de
 * emergencia a quien sí lo tiene. Con 120 bits de código, adivinarlo no es el
 * riesgo; el freno por IP basta para que no se pruebe a lo loco.
 */
const FALLOS_POR_IP = 5;
const VENTANA_FALLOS = 15 * 60_000;
const fallos = new Map<string, number[]>();

function frenado(ip: string, ahora: number) {
	for (const [k, v] of fallos) {
		const vivos = v.filter((t) => ahora - t < VENTANA_FALLOS);
		if (vivos.length) fallos.set(k, vivos);
		else fallos.delete(k);
	}
	return (fallos.get(ip)?.length ?? 0) >= FALLOS_POR_IP;
}

export function _olvidarFallos() {
	fallos.clear();
}

/*
 * Entrar con el código. Se gasta de forma atómica (solo borra la fila si el hash
 * coincide), así que dos peticiones a la vez no entran las dos. Si vale, deja
 * puesto el siguiente y lo devuelve para enseñarlo.
 */
export async function canjearCodigoEmergencia(codigo: string, ip: string, ahora = Date.now()) {
	if (frenado(ip, ahora)) return { ok: false as const, motivo: 'frenado' as const };
	const limpio = normalizarCodigo(codigo);
	const gastado =
		limpio.length === 24
			? await db
					.delete(s.ajustes)
					.where(
						and(
							eq(s.ajustes.clave, AJUSTE_CODIGO),
							sql`${s.ajustes.valor}->>'hash' = ${hash(limpio)}`
						)
					)
					.returning()
			: [];
	if (gastado.length === 0) {
		fallos.set(ip, [...(fallos.get(ip) ?? []), ahora]);
		await auditar('anonymous', 'emergency code rejected', { ip });
		return { ok: false as const, motivo: 'invalido' as const };
	}
	await auditar('emergency · code', 'EMERGENCY SIGN-IN', { via: 'code', ip });
	return { ok: true as const, nuevo: await nuevoCodigoEmergencia('emergency · code') };
}
