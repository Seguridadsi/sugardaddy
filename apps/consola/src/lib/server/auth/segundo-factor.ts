/*
 * Segundo factor de los usuarios locales (plan de fortificación §4.1, DORA
 * B-10): passkeys (WebAuthn) y apps de autenticación (TOTP), con diez códigos
 * de recuperación de un solo uso.
 *
 * Cómo se entra con login local:
 *   contraseña → segundo factor (o su alta) → cambios pendientes → sesión
 * La sesión no se abre hasta el final. Entre paso y paso, lo que se lleva es un
 * «paso» en memoria (como los retos de la entrada de emergencia) con una cookie
 * de vida corta bajo /sign-in. Si el proceso se reinicia, se vuelve a entrar.
 *
 * Exigirlo es un ajuste de la consola (Ajustes → Access), ENCENDIDO de serie,
 * también en las consolas que ya existían: quien aún no tiene un segundo factor
 * lo da de alta al entrar, así que nadie se queda fuera (tampoco el último
 * administrador). Quien ya tiene uno lo usa siempre, esté exigido o no.
 *
 * Lo que no cambia: la entrada de emergencia (llave FIDO2 o código de 120 bits)
 * sigue sin pedirlo, porque es la salida cuando todo lo demás se ha perdido, y
 * queda en la auditoría como crítica. Quien entra con Entra o con OIDC trae el
 * MFA de su proveedor de identidad.
 *
 * Todo cambio va a la auditoría con textos que salen al SIEM como
 * auditoria.mfa (salidas/auditoria.ts): «two-factor …».
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type AuthenticatorTransport,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { cifrar, descifrar, estadoClave } from '../secretos';
import type { Identidad } from './entra';
import {
	COOKIE_CAMBIO,
	abrirRetoCambio,
	cerrarSesionesDe,
	claveCorrecta,
	intentoSegundoFactor,
	pendientesAlEntrar,
	sinFallos
} from './local';
import { abrir } from './sesion';
import * as totp from './totp';

export type Factor = 'passkey' | 'totp' | 'recuperacion';

const AJUSTE = 'segundo_factor';
const NOMBRE_MAX = 60;
const CODIGOS = 10;
/* Intentos de segundo factor por cada contraseña buena: luego, a empezar de nuevo. */
export const INTENTOS_POR_PASO = 5;

/* ---------- el ajuste: exigirlo o no ---------- */

type Ajuste = { exigir: boolean; por: string; cuando: string };

async function leerAjuste(): Promise<Ajuste | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE));
	return (f?.valor as Ajuste | undefined) ?? null;
}

/* Sin ajuste guardado: exigido (de serie en las nuevas y en las que ya existían). */
export async function exigido(): Promise<boolean> {
	return (await leerAjuste())?.exigir ?? true;
}

export async function estadoExigencia() {
	const a = await leerAjuste();
	return { exigir: a?.exigir ?? true, por: a?.por ?? null, cuando: a?.cuando ?? null };
}

export async function fijarExigido(quien: string, exigir: boolean) {
	const valor: Ajuste = { exigir, por: quien, cuando: new Date().toISOString() };
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
	await auditar(
		quien,
		exigir ? 'two-factor requirement turned on' : 'two-factor requirement turned off'
	);
}

/* TOTP necesita la clave del nodo: el secreto se guarda cifrado. */
export const totpDisponible = () => estadoClave() === 'lista';

/* ---------- los factores de un usuario ---------- */

export const factores = (usuarioId: string) =>
	db
		.select({
			id: s.factoresUsuario.id,
			tipo: s.factoresUsuario.tipo,
			nombre: s.factoresUsuario.nombre,
			creada: s.factoresUsuario.creada,
			ultimoUso: s.factoresUsuario.ultimoUso
		})
		.from(s.factoresUsuario)
		.where(eq(s.factoresUsuario.usuarioId, usuarioId))
		.orderBy(s.factoresUsuario.creada);

export async function codigosRestantes(usuarioId: string) {
	const [r] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(s.codigosRecuperacionMfa)
		.where(eq(s.codigosRecuperacionMfa.usuarioId, usuarioId));
	return r?.n ?? 0;
}

/* Para la lista de usuarios: cuántos de cada tipo tiene cada uno. */
export async function resumenPorUsuario() {
	const filas = await db
		.select({
			usuarioId: s.factoresUsuario.usuarioId,
			tipo: s.factoresUsuario.tipo,
			n: sql<number>`count(*)::int`
		})
		.from(s.factoresUsuario)
		.groupBy(s.factoresUsuario.usuarioId, s.factoresUsuario.tipo);
	const r = new Map<string, { passkey: number; totp: number }>();
	for (const f of filas) {
		const v = r.get(f.usuarioId) ?? { passkey: 0, totp: 0 };
		v[f.tipo] = f.n;
		r.set(f.usuarioId, v);
	}
	return r;
}

const nombreUsuario = async (id: string) =>
	(
		await db
			.select({ u: s.usuariosLocales.usuario })
			.from(s.usuariosLocales)
			.where(eq(s.usuariosLocales.id, id))
	)[0]?.u ?? null;

const limpiarNombre = (n: string, porDefecto: string) =>
	n.trim().replace(/\s+/g, ' ').slice(0, NOMBRE_MAX) || porDefecto;

/* ---------- códigos de recuperación ---------- */

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const hash = (c: string) => createHash('sha256').update(c).digest('hex');
const normalizar = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/* Diez letras o cifras (50 bits) en dos grupos: XXXXX-XXXXX. */
export function generarCodigo() {
	const c = Array.from(randomBytes(10), (x) => ALFABETO[x & 31]).join('');
	return `${c.slice(0, 5)}-${c.slice(5)}`;
}

/* Cambia los códigos del usuario por diez nuevos y los devuelve: es la única vez que se ven. */
export async function nuevosCodigos(quien: string, usuarioId: string): Promise<string[]> {
	const codigos = Array.from({ length: CODIGOS }, generarCodigo);
	await db.transaction(async (tx) => {
		await tx
			.delete(s.codigosRecuperacionMfa)
			.where(eq(s.codigosRecuperacionMfa.usuarioId, usuarioId));
		await tx
			.insert(s.codigosRecuperacionMfa)
			.values(codigos.map((c) => ({ usuarioId, hash: hash(normalizar(c)) })));
	});
	await auditar(quien, 'two-factor recovery codes generated', {
		usuario: await nombreUsuario(usuarioId)
	});
	return codigos;
}

/* Gasta un código de forma atómica: de dos a la vez con el mismo, solo uno vale. */
async function gastarCodigo(usuarioId: string, codigo: string) {
	const limpio = normalizar(codigo);
	if (limpio.length !== 10) return false;
	const r = await db
		.delete(s.codigosRecuperacionMfa)
		.where(
			and(
				eq(s.codigosRecuperacionMfa.usuarioId, usuarioId),
				eq(s.codigosRecuperacionMfa.hash, hash(limpio))
			)
		)
		.returning({ hash: s.codigosRecuperacionMfa.hash });
	return r.length > 0;
}

/* ---------- TOTP ---------- */

const contextoTotp = (usuarioId: string) => `totp:${usuarioId}`;

/* Guarda una app de autenticación, si el código que enseña casa con el secreto. */
export async function altaTotp(
	quien: string,
	usuarioId: string,
	secreto: string,
	codigo: string,
	nombre: string,
	ahora = Date.now()
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!totpDisponible())
		return {
			ok: false,
			error:
				'This node has no key for storing secrets (CLAVE_SECRETOS), so authenticator apps cannot be used. Use a passkey.'
		};
	const b = totp.desdeBase32(secreto);
	if (!b || b.length < 16) return { ok: false, error: 'The setup key is not valid. Start again.' };
	const paso = totp.comprobar(secreto, codigo, ahora);
	if (paso === null)
		return {
			ok: false,
			error:
				'That code does not match. Check that the time on your phone is set automatically and enter the current code.'
		};
	await db.insert(s.factoresUsuario).values({
		id: randomUUID(),
		usuarioId,
		tipo: 'totp',
		nombre: limpiarNombre(nombre, 'Authenticator app'),
		secreto: cifrar({ secreto }, contextoTotp(usuarioId)),
		ultimoPaso: paso
	});
	await auditar(quien, 'two-factor (authenticator app) registered', {
		usuario: await nombreUsuario(usuarioId)
	});
	return { ok: true };
}

/*
 * Comprueba un código contra las apps del usuario. Solo vale un intervalo
 * posterior al último usado en esa app, y se apunta en la misma sentencia: el
 * mismo código no entra dos veces, tampoco a la vez.
 */
async function comprobarTotp(usuarioId: string, codigo: string, ahora: number) {
	const apps = await db
		.select()
		.from(s.factoresUsuario)
		.where(and(eq(s.factoresUsuario.usuarioId, usuarioId), eq(s.factoresUsuario.tipo, 'totp')));
	for (const a of apps) {
		const d = a.secreto ? descifrar(a.secreto, contextoTotp(usuarioId)) : null;
		if (!d?.ok) continue;
		const paso = totp.comprobar(d.valores.secreto, codigo, ahora);
		if (paso === null) continue;
		const [hecho] = await db
			.update(s.factoresUsuario)
			.set({ ultimoPaso: paso, ultimoUso: new Date(ahora) })
			.where(and(eq(s.factoresUsuario.id, a.id), sql`${s.factoresUsuario.ultimoPaso} < ${paso}`))
			.returning({ id: s.factoresUsuario.id });
		if (hecho) return true;
	}
	return false;
}

/* ---------- passkeys ---------- */

export async function opcionesAltaPasskey(rpID: string, usuarioId: string, usuario: string) {
	const existentes = await db
		.select({ id: s.factoresUsuario.id, transportes: s.factoresUsuario.transportes })
		.from(s.factoresUsuario)
		.where(and(eq(s.factoresUsuario.usuarioId, usuarioId), eq(s.factoresUsuario.tipo, 'passkey')));
	return generateRegistrationOptions({
		rpName: 'Sugardaddy',
		rpID,
		userName: usuario,
		userID: new TextEncoder().encode(usuarioId),
		attestationType: 'none',
		excludeCredentials: existentes.map((e) => ({
			id: e.id,
			transports: (e.transportes ?? undefined) as AuthenticatorTransport[] | undefined
		})),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
	});
}

export async function altaPasskey(
	quien: string,
	usuarioId: string,
	reto: string,
	respuesta: RegistrationResponseJSON,
	origen: string,
	rpID: string,
	nombre: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	const v = await verifyRegistrationResponse({
		response: respuesta,
		expectedChallenge: reto,
		expectedOrigin: origen,
		expectedRPID: rpID,
		requireUserVerification: false
	}).catch(() => ({ verified: false as const }));
	if (!v.verified || !('registrationInfo' in v) || !v.registrationInfo)
		return { ok: false, error: 'The passkey did not pass verification. Try again.' };
	const { credential } = v.registrationInfo;
	try {
		await db.insert(s.factoresUsuario).values({
			id: credential.id,
			usuarioId,
			tipo: 'passkey',
			nombre: limpiarNombre(nombre, 'Passkey'),
			clavePublica: Buffer.from(credential.publicKey).toString('base64'),
			contador: credential.counter,
			transportes: credential.transports ?? null
		});
	} catch {
		return { ok: false, error: 'That passkey is already registered.' };
	}
	await auditar(quien, 'two-factor (passkey) registered', {
		usuario: await nombreUsuario(usuarioId)
	});
	return { ok: true };
}

export async function opcionesEntradaPasskey(rpID: string, usuarioId: string) {
	const llaves = await db
		.select({ id: s.factoresUsuario.id, transportes: s.factoresUsuario.transportes })
		.from(s.factoresUsuario)
		.where(and(eq(s.factoresUsuario.usuarioId, usuarioId), eq(s.factoresUsuario.tipo, 'passkey')));
	if (llaves.length === 0) return null;
	return generateAuthenticationOptions({
		rpID,
		userVerification: 'preferred',
		allowCredentials: llaves.map((l) => ({
			id: l.id,
			transports: (l.transportes ?? undefined) as AuthenticatorTransport[] | undefined
		}))
	});
}

async function comprobarPasskey(
	usuarioId: string,
	reto: string,
	respuesta: AuthenticationResponseJSON,
	origen: string,
	rpID: string
) {
	const [llave] = await db
		.select()
		.from(s.factoresUsuario)
		.where(
			and(
				eq(s.factoresUsuario.id, respuesta.id),
				eq(s.factoresUsuario.usuarioId, usuarioId),
				eq(s.factoresUsuario.tipo, 'passkey')
			)
		);
	if (!llave?.clavePublica) return false;
	const v = await verifyAuthenticationResponse({
		response: respuesta,
		expectedChallenge: reto,
		expectedOrigin: origen,
		expectedRPID: rpID,
		requireUserVerification: false,
		credential: {
			id: llave.id,
			publicKey: new Uint8Array(Buffer.from(llave.clavePublica, 'base64')),
			counter: llave.contador
		}
	}).catch(() => ({ verified: false as const }));
	if (!v.verified || !('authenticationInfo' in v)) return false;
	await db
		.update(s.factoresUsuario)
		.set({ contador: v.authenticationInfo.newCounter, ultimoUso: new Date() })
		.where(eq(s.factoresUsuario.id, llave.id));
	return true;
}

/* ---------- quitar y restablecer ---------- */

/*
 * El usuario quita uno de los suyos, con su contraseña. Mientras esté exigido,
 * no puede quedarse sin ninguno: primero añade otro.
 */
export async function quitarFactor(
	quien: string,
	usuarioId: string,
	factorId: string,
	clave: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!(await claveCorrecta(usuarioId, clave)))
		return { ok: false, error: 'Enter your current password to remove a sign-in method.' };
	const r = await db.transaction(async (tx) => {
		const suyos = await tx
			.select({
				id: s.factoresUsuario.id,
				nombre: s.factoresUsuario.nombre,
				tipo: s.factoresUsuario.tipo
			})
			.from(s.factoresUsuario)
			.where(eq(s.factoresUsuario.usuarioId, usuarioId))
			.for('update');
		const f = suyos.find((x) => x.id === factorId);
		if (!f) return { ok: false as const, error: 'That sign-in method no longer exists.' };
		if (suyos.length === 1 && (await exigido()))
			return {
				ok: false as const,
				error:
					'Two-factor authentication is required on this console: add another method before removing this one.'
			};
		await tx.delete(s.factoresUsuario).where(eq(s.factoresUsuario.id, factorId));
		/* Sin ningún factor, los códigos de recuperación ya no sirven de nada. */
		if (suyos.length === 1)
			await tx
				.delete(s.codigosRecuperacionMfa)
				.where(eq(s.codigosRecuperacionMfa.usuarioId, usuarioId));
		return { ok: true as const, f };
	});
	if (!r.ok) return r;
	await auditar(quien, 'two-factor removed', {
		usuario: await nombreUsuario(usuarioId),
		tipo: r.f.tipo,
		nombre: r.f.nombre
	});
	return { ok: true };
}

/*
 * Un administrador le quita a otro usuario todos sus factores y códigos (perdió
 * el móvil). El usuario da de alta uno nuevo al volver a entrar; sus sesiones
 * abiertas se cierran. A sí mismo no: para eso está Mi cuenta (y así una sesión
 * robada no se libra del segundo factor de su dueño).
 */
export async function restablecerSegundoFactor(
	quien: string,
	quienOid: string | undefined,
	usuarioId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (quienOid === `local:${usuarioId}`)
		return {
			ok: false,
			error: 'You cannot reset your own two-factor authentication. Manage it under Account.'
		};
	const usuario = await nombreUsuario(usuarioId);
	if (!usuario) return { ok: false, error: 'That user no longer exists.' };
	await db.transaction(async (tx) => {
		await tx.delete(s.factoresUsuario).where(eq(s.factoresUsuario.usuarioId, usuarioId));
		await tx
			.delete(s.codigosRecuperacionMfa)
			.where(eq(s.codigosRecuperacionMfa.usuarioId, usuarioId));
		await cerrarSesionesDe(usuarioId, undefined, tx);
	});
	await auditar(quien, 'two-factor reset by an administrator', { usuario });
	return { ok: true };
}

/* ---------- la entrada, paso a paso ---------- */

export const COOKIE_PASO = 'sd_segundo_factor';
const VIDA_PASO = 10 * 60_000;
const MAX_PASOS = 1000;

type Paso = {
	id: string;
	identidad: Identidad;
	volverA: string;
	modo: 'verificar' | 'alta';
	intentos: number;
	caduca: number;
	/* Alta: el secreto TOTP propuesto (se queda aquí, no viaja en el formulario). */
	secretoAlta?: string;
	/* El reto WebAuthn en curso. */
	reto?: string;
	/* Ya dio de alta un factor: le quedan por ver sus códigos y seguir. */
	hecho?: Factor;
};

const pasos = new Map<string, Paso>();

function limpiarPasos(ahora = Date.now()) {
	for (const [k, v] of pasos) if (v.caduca < ahora) pasos.delete(k);
	while (pasos.size >= MAX_PASOS) pasos.delete(pasos.keys().next().value as string);
}

export function leerPaso(cookies: Cookies): Paso | null {
	const t = cookies.get(COOKIE_PASO);
	const p = t ? pasos.get(t) : undefined;
	if (!p || p.caduca < Date.now()) return null;
	return p;
}

export function cerrarPaso(cookies: Cookies) {
	const t = cookies.get(COOKIE_PASO);
	if (t) pasos.delete(t);
	cookies.delete(COOKIE_PASO, { path: '/sign-in', secure: true });
}

/* ¿Qué le toca a este usuario tras la contraseña? */
export async function queToca(usuarioId: string): Promise<'verificar' | 'alta' | null> {
	const [r] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(s.factoresUsuario)
		.where(eq(s.factoresUsuario.usuarioId, usuarioId));
	if ((r?.n ?? 0) > 0) return 'verificar';
	return (await exigido()) ? 'alta' : null;
}

/* La sesión, por fin, y su línea en la auditoría. */
export async function entrar(cookies: Cookies, identidad: Identidad, factor: Factor | null) {
	await abrir(cookies, identidad, factor);
	await auditar(identidad.correo, 'local sign-in', {
		roles: identidad.roles,
		...(factor ? { factor } : {})
	});
}

/* Tras el segundo factor (o sin él): lo que le falte al usuario y, si nada, la sesión. Devuelve adónde ir. */
export async function despuesDelFactor(
	cookies: Cookies,
	usuarioId: string,
	identidad: Identidad,
	volverA: string,
	factor: Factor | null
): Promise<string> {
	const p = await pendientesAlEntrar(usuarioId);
	if (p && (p.clave || p.correo)) {
		cookies.set(COOKIE_CAMBIO, abrirRetoCambio(usuarioId, factor), {
			path: '/sign-in',
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			maxAge: 600
		});
		return `/sign-in/change?volverA=${encodeURIComponent(volverA)}`;
	}
	await entrar(cookies, identidad, factor);
	return volverA;
}

/* Tras una contraseña buena: el segundo factor si toca y, si no, lo siguiente. Devuelve adónde ir. */
export async function despuesDeLaClave(
	cookies: Cookies,
	usuarioId: string,
	identidad: Identidad,
	volverA: string
): Promise<string> {
	const modo = await queToca(usuarioId);
	if (!modo) return despuesDelFactor(cookies, usuarioId, identidad, volverA, null);
	limpiarPasos();
	const token = randomBytes(24).toString('base64url');
	pasos.set(token, {
		id: usuarioId,
		identidad,
		volverA,
		modo,
		intentos: 0,
		caduca: Date.now() + VIDA_PASO
	});
	cookies.set(COOKIE_PASO, token, {
		path: '/sign-in',
		httpOnly: true,
		sameSite: 'strict',
		secure: true,
		maxAge: VIDA_PASO / 1000
	});
	return '/sign-in/second-factor';
}

/* El secreto TOTP que se propone en el alta: el mismo mientras dure el paso. */
export function secretoAlta(p: Paso) {
	p.secretoAlta ??= totp.generarSecreto();
	return p.secretoAlta;
}

export type Comprobacion =
	{ ok: true; factor: Factor; quedan?: number } | { ok: false; error: string; fin?: boolean };

const MAL = 'That code is not valid. Try again.';

/* Un intento fallido más en este paso. Al quinto se acaba: hay que volver a la contraseña. */
async function fallo(cookies: Cookies, p: Paso, motivo: string): Promise<Comprobacion> {
	p.intentos++;
	await auditar('anonymous', 'local sign-in denied', {
		usuario: (await nombreUsuario(p.id))?.slice(0, 64),
		motivo
	});
	if (p.intentos >= INTENTOS_POR_PASO) {
		cerrarPaso(cookies);
		return { ok: false, error: 'Too many attempts. Sign in again.', fin: true };
	}
	return { ok: false, error: MAL };
}

/* Antes de mirar nada: gasta un intento del usuario (freno persistente) o dice que está bloqueado. */
async function frenar(cookies: Cookies, p: Paso): Promise<Comprobacion | null> {
	if (await intentoSegundoFactor(p.id)) return null;
	cerrarPaso(cookies);
	await auditar('anonymous', 'local sign-in denied', {
		usuario: (await nombreUsuario(p.id))?.slice(0, 64),
		motivo: 'bloqueado'
	});
	return {
		ok: false,
		error: 'Too many attempts. Wait a few minutes and sign in again.',
		fin: true
	};
}

export async function verificarCodigo(
	cookies: Cookies,
	p: Paso,
	codigo: string,
	ahora = Date.now()
): Promise<Comprobacion> {
	const parado = await frenar(cookies, p);
	if (parado) return parado;
	if (await comprobarTotp(p.id, codigo, ahora)) {
		await sinFallos(p.id);
		return { ok: true, factor: 'totp' };
	}
	return fallo(cookies, p, 'second factor: wrong code');
}

export async function verificarRecuperacion(
	cookies: Cookies,
	p: Paso,
	codigo: string
): Promise<Comprobacion> {
	const parado = await frenar(cookies, p);
	if (parado) return parado;
	if (await gastarCodigo(p.id, codigo)) {
		await sinFallos(p.id);
		const quedan = await codigosRestantes(p.id);
		await auditar(p.identidad.correo, 'two-factor recovery code used', {
			usuario: await nombreUsuario(p.id),
			quedan
		});
		return { ok: true, factor: 'recuperacion', quedan };
	}
	return fallo(cookies, p, 'second factor: wrong recovery code');
}

export async function verificarPasskey(
	cookies: Cookies,
	p: Paso,
	respuesta: AuthenticationResponseJSON,
	origen: string,
	rpID: string
): Promise<Comprobacion> {
	const reto = p.reto;
	p.reto = undefined;
	if (!reto) return { ok: false, error: 'The request has expired. Try again.' };
	const parado = await frenar(cookies, p);
	if (parado) return parado;
	if (await comprobarPasskey(p.id, reto, respuesta, origen, rpID)) {
		await sinFallos(p.id);
		return { ok: true, factor: 'passkey' };
	}
	return fallo(cookies, p, 'second factor: passkey rejected');
}

export async function opcionesPasoPasskey(p: Paso, rpID: string) {
	const o =
		p.modo === 'verificar'
			? await opcionesEntradaPasskey(rpID, p.id)
			: await opcionesAltaPasskey(rpID, p.id, (await nombreUsuario(p.id)) ?? 'user');
	if (o) p.reto = o.challenge;
	return o;
}

/* Alta durante la entrada: el paso queda «hecho» y se le dan sus códigos para que los guarde. */
export async function altaEnPasoTotp(p: Paso, codigo: string, nombre: string) {
	if (p.modo !== 'alta' || p.hecho || !p.secretoAlta)
		return { ok: false as const, error: 'Start again.' };
	const r = await altaTotp(p.identidad.correo, p.id, p.secretoAlta, codigo, nombre);
	if (!r.ok) return r;
	p.hecho = 'totp';
	return { ok: true as const, codigos: await nuevosCodigos(p.identidad.correo, p.id) };
}

export async function altaEnPasoPasskey(
	p: Paso,
	respuesta: RegistrationResponseJSON,
	origen: string,
	rpID: string,
	nombre: string
) {
	const reto = p.reto;
	p.reto = undefined;
	if (p.modo !== 'alta' || p.hecho || !reto) return { ok: false as const, error: 'Start again.' };
	const r = await altaPasskey(p.identidad.correo, p.id, reto, respuesta, origen, rpID, nombre);
	if (!r.ok) return r;
	p.hecho = 'passkey';
	return { ok: true as const, codigos: await nuevosCodigos(p.identidad.correo, p.id) };
}

/* Para las pruebas. */
export const _pasos = pasos;
