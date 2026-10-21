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
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import { db, schema as s } from './db';
import { auditar } from './consultas';

const VIDA_RETO = 5 * 60_000;
const retos = new Map<string, { reto: string; caduca: number; nombre?: string; quien?: string }>();

function guardarReto(datos: { reto: string; nombre?: string; quien?: string }) {
	for (const [k, v] of retos) if (v.caduca < Date.now()) retos.delete(k);
	const id = randomBytes(24).toString('base64url');
	retos.set(id, { ...datos, caduca: Date.now() + VIDA_RETO });
	return id;
}

/* Un reto vale una sola vez. */
function tomarReto(id: string | undefined) {
	if (!id) return null;
	const r = retos.get(id);
	retos.delete(id);
	return r && r.caduca > Date.now() ? r : null;
}

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

async function gastarCodigo() {
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'emergencia_alta'));
}

/* ---------- registro ---------- */

export async function opcionesRegistro(rpID: string, nombre: string, quien: string) {
	const existentes = await llaves();
	const opciones = await generateRegistrationOptions({
		rpName: 'Sugardaddy',
		rpID,
		userName: `emergencia · ${nombre}`,
		attestationType: 'none',
		excludeCredentials: existentes.map((l) => ({ id: l.id })),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }
	});
	return { opciones, reto: guardarReto({ reto: opciones.challenge, nombre, quien }) };
}

export async function registrar(
	retoId: string | undefined,
	respuesta: RegistrationResponseJSON,
	origen: string,
	rpID: string,
	conCodigo: boolean
) {
	const r = tomarReto(retoId);
	if (!r) return { ok: false as const, motivo: 'El reto ha caducado. Vuelve a empezar.' };
	const v = await verifyRegistrationResponse({
		response: respuesta,
		expectedChallenge: r.reto,
		expectedOrigin: origen,
		expectedRPID: rpID,
		requireUserVerification: true
	}).catch((e: Error) => ({ verified: false as const, error: e.message }));
	if (!v.verified || !('registrationInfo' in v) || !v.registrationInfo)
		return { ok: false as const, motivo: 'La llave no ha superado la verificación.' };
	const { credential } = v.registrationInfo;
	await db.insert(s.llavesEmergencia).values({
		id: credential.id,
		clavePublica: Buffer.from(credential.publicKey).toString('base64'),
		contador: credential.counter,
		nombre: r.nombre!,
		registradaPor: r.quien!
	});
	if (conCodigo) await gastarCodigo();
	await auditar(r.quien!, 'llave de emergencia registrada', { nombre: r.nombre, conCodigo });
	return { ok: true as const };
}

export async function retirarLlave(quien: string, id: string) {
	const [f] = await db.delete(s.llavesEmergencia).where(eq(s.llavesEmergencia.id, id)).returning();
	if (f) await auditar(quien, 'llave de emergencia retirada', { nombre: f.nombre });
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
