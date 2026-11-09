/*
 * Login local de la consola: usuario y contraseña guardados en el propio nodo,
 * para quien no quiere (o no puede) federar con Entra ID. Convive con Entra; la
 * elección se hace al instalar (docs/diseno/auth-login.md). La entrada de
 * emergencia con llave FIDO2 sigue estando en los dos modos.
 *
 * Reglas que no se tocan:
 *  - La contraseña NUNCA se guarda en claro ni cifrada de forma reversible: solo
 *    un hash scrypt con sal por usuario. La comprobación es en tiempo constante.
 *  - El freno a la fuerza bruta (intentos + bloqueo creciente) vive en la base
 *    de datos del nodo, así que aguanta reinicios.
 *  - Entrar da una sesión normal (sesion.ts) con oid `local:<id>`.
 *
 * El formato del hash lo comparte el sembrado del primer administrador
 * (scripts/preparar-base.mjs): si cambia aquí, cámbialo también allí.
 */
import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { ROLES, type Rol } from './permisos';
import type { Identidad } from './entra';

/* Parámetros de scrypt. 2^15 de coste; maxmem explícito porque 2^15 pasa del tope por defecto. */
const N = 1 << 15;
const R = 8;
const P = 1;
const LONGITUD = 32;
const MAXMEM = 64 * 1024 * 1024;

/* Longitud mínima de contraseña. Mejor una frase larga que reglas de símbolos. */
export const MIN_CLAVE = 12;

/* Freno a la fuerza bruta: a partir de UMBRAL fallos, bloqueo que crece hasta el tope. */
const UMBRAL = 5;
const BLOQUEO_MAX_MS = 15 * 60_000;
function bloqueoMs(fallos: number) {
	if (fallos < UMBRAL) return 0;
	return Math.min(BLOQUEO_MAX_MS, 30_000 * 2 ** (fallos - UMBRAL));
}

const norma = (u: string) => u.trim().toLowerCase();
/* De 3 a 32: letras, números, punto, guion o guion bajo; empieza y acaba en letra o número. */
const USUARIO_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
export const usuarioValido = (u: string) => USUARIO_RE.test(norma(u));

/*
 * Correo de recuperación: cada usuario local necesita uno de verdad, porque es
 * adonde va el código si pierde la contraseña (/sign-in/recover). El primer
 * administrador nace con «admin@local» (el instalador no lo sabe), así que la
 * consola se lo pide al entrar. Basta con «algo@dominio.tld» sin espacios: si el
 * buzón existe ya lo dirá el correo que le llegue.
 */
const CORREO_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@.]{2,}$/;
export const correoValido = (c: string) => c.trim().length <= 254 && CORREO_RE.test(c.trim());

export function loginLocalHabilitado() {
	return env.LOGIN_LOCAL === '1' || env.EDICION === 'community';
}

/* ---------- hash de contraseñas (scrypt) ---------- */

export function hashClave(clave: string): string {
	const sal = randomBytes(16);
	const h = scryptSync(clave, sal, LONGITUD, { N, r: R, p: P, maxmem: MAXMEM });
	return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${h.toString('base64')}`;
}

type PartesHash = { n: number; r: number; q: number; sal: Buffer; esperado: Buffer };

function partesHash(almacenado: string): PartesHash | null {
	const p = almacenado.split('$');
	if (p.length !== 6 || p[0] !== 'scrypt') return null;
	const n = Number(p[1]);
	const r = Number(p[2]);
	const q = Number(p[3]);
	if (
		!Number.isInteger(n) ||
		!Number.isInteger(r) ||
		!Number.isInteger(q) ||
		n < 2 ||
		r < 1 ||
		q < 1
	)
		return null;
	const sal = Buffer.from(p[4], 'base64');
	const esperado = Buffer.from(p[5], 'base64');
	if (sal.length === 0 || esperado.length === 0) return null;
	return { n, r, q, sal, esperado };
}

export function comprobarClave(clave: string, almacenado: string): boolean {
	const x = partesHash(almacenado);
	if (!x) return false;
	let h: Buffer;
	try {
		h = scryptSync(clave, x.sal, x.esperado.length, { N: x.n, r: x.r, p: x.q, maxmem: MAXMEM });
	} catch {
		return false;
	}
	return h.length === x.esperado.length && timingSafeEqual(h, x.esperado);
}

/*
 * Lo mismo sin bloquear el proceso: scrypt va al pool de libuv y, como mucho,
 * MAX_SCRYPT a la vez; el resto espera su turno. Con la versión síncrona, una
 * ráfaga de intentos de entrada (unos 60 ms cada uno) congelaba la consola
 * entera, también la recepción de eventos de los sensores.
 */
const MAX_SCRYPT = 2;
let scryptEnCurso = 0;
const scryptEnCola: (() => void)[] = [];

async function enTurno<T>(f: () => Promise<T>): Promise<T> {
	while (scryptEnCurso >= MAX_SCRYPT) await new Promise<void>((ok) => scryptEnCola.push(ok));
	scryptEnCurso++;
	try {
		return await f();
	} finally {
		scryptEnCurso--;
		scryptEnCola.shift()?.();
	}
}

export async function comprobarClaveAsync(clave: string, almacenado: string): Promise<boolean> {
	const x = partesHash(almacenado);
	if (!x) return false;
	try {
		const h = await enTurno(
			() =>
				new Promise<Buffer>((ok, mal) =>
					scrypt(
						clave,
						x.sal,
						x.esperado.length,
						{ N: x.n, r: x.r, p: x.q, maxmem: MAXMEM },
						(e, b) => (e ? mal(e) : ok(b))
					)
				)
		);
		return h.length === x.esperado.length && timingSafeEqual(h, x.esperado);
	} catch {
		return false;
	}
}

/*
 * Un hash de descarte, para gastar el mismo tiempo cuando el usuario no existe:
 * así no se distingue «usuario desconocido» de «contraseña mala» por el reloj.
 */
const HASH_FALSO = hashClave(randomBytes(18).toString('base64url'));

/* ---------- entrada ---------- */

export type ResultadoEntrada =
	| { ok: true; identidad: Identidad; id: string; debeCambiar: boolean; pideCorreo: boolean }
	| { ok: false; motivo: 'credenciales' | 'bloqueado'; hasta?: Date };

function identidadDe(u: {
	id: string;
	correo: string;
	nombre: string;
	roles: string[];
}): Identidad {
	const roles = u.roles.filter((r): r is Rol => (ROLES as readonly string[]).includes(r));
	return { oid: `local:${u.id}`, correo: u.correo, nombre: u.nombre, roles, soporte: false };
}

/*
 * Gasta un intento ANTES de mirar la contraseña, de forma atómica y solo si no
 * está bloqueado: la misma sentencia mira el bloqueo y suma, así que varios
 * intentos a la vez no ven todos «sin bloquear» (Postgres vuelve a evaluar la
 * condición de cada uno tras el anterior). Si con este llega al umbral, el
 * bloqueo se pone ya; si la contraseña resulta buena, verificar lo quita.
 * false si estaba bloqueado: entonces ni se mira la contraseña.
 */
async function gastarIntento(id: string, ahora: number): Promise<boolean> {
	const u = s.usuariosLocales;
	const momento = new Date(ahora);
	/*
	 * El bloqueo va en la MISMA sentencia que el intento: si se pusiera después,
	 * entre una y otra cabrían más intentos en paralelo. Su duración es la de
	 * bloqueoMs, en segundos: 30 · 2^(fallos − UMBRAL), hasta BLOQUEO_MAX_MS.
	 * El exponente va topado: con miles de fallos power() desborda el double y
	 * Postgres da error en vez de topar, y la cuenta no volvería a entrar nunca.
	 */
	const [fila] = await db
		.update(u)
		.set({
			intentosFallidos: sql`${u.intentosFallidos} + 1`,
			bloqueadoHasta: sql`case when ${u.intentosFallidos} + 1 >= ${UMBRAL}
				then ${momento.toISOString()}::timestamptz + make_interval(secs => least(${BLOQUEO_MAX_MS / 1000}, 30 * power(2, least(${u.intentosFallidos} + 1 - ${UMBRAL}, 10))))
				else ${u.bloqueadoHasta} end`
		})
		.where(and(eq(u.id, id), or(isNull(u.bloqueadoHasta), lte(u.bloqueadoHasta, momento))))
		.returning({ fallos: u.intentosFallidos });
	return !!fila;
}

export async function verificar(usuario: string, clave: string): Promise<ResultadoEntrada> {
	const nombreU = norma(usuario);
	const [u] = nombreU
		? await db.select().from(s.usuariosLocales).where(eq(s.usuariosLocales.usuario, nombreU))
		: [];
	const ahora = Date.now();

	/* Bloqueado por intentos: ni se mira la contraseña. */
	if (u && !(await gastarIntento(u.id, ahora))) {
		const [b] = await db
			.select({ hasta: s.usuariosLocales.bloqueadoHasta })
			.from(s.usuariosLocales)
			.where(eq(s.usuariosLocales.id, u.id));
		return { ok: false, motivo: 'bloqueado', hasta: b?.hasta ?? undefined };
	}

	/* Siempre se calcula un scrypt (con el hash real o con el falso): tiempo constante. */
	const correcto = (await comprobarClaveAsync(clave, u?.claveHash ?? HASH_FALSO)) && !!u;

	if (!u || !correcto) return { ok: false, motivo: 'credenciales' };

	await db
		.update(s.usuariosLocales)
		.set({ intentosFallidos: 0, bloqueadoHasta: null, ultimoAcceso: new Date(ahora) })
		.where(eq(s.usuariosLocales.id, u.id));
	return {
		ok: true,
		id: u.id,
		debeCambiar: u.debeCambiar,
		pideCorreo: !correoValido(u.correo),
		identidad: identidadDe(u)
	};
}

/* ---------- antes de entrar: contraseña de un solo uso y correo de recuperación ---------- */

/*
 * Un reto de un solo uso para el cambio forzado: al entrar con una contraseña de
 * un solo uso, la consola no abre sesión todavía; guarda aquí el id del usuario
 * y manda a /sign-in/change. Vive en memoria y dura poco, como los retos de la
 * entrada de emergencia; si el proceso se reinicia, se vuelve a entrar.
 */
/* La cookie del cambio forzado vive solo bajo /sign-in (la leen /sign-in y /sign-in/change). */
export const COOKIE_CAMBIO = 'sd_cambio';

const VIDA_RETO = 10 * 60_000;
const retosCambio = new Map<string, { id: string; caduca: number }>();

export function abrirRetoCambio(idUsuario: string): string {
	for (const [k, v] of retosCambio) if (v.caduca < Date.now()) retosCambio.delete(k);
	const reto = randomBytes(24).toString('base64url');
	retosCambio.set(reto, { id: idUsuario, caduca: Date.now() + VIDA_RETO });
	return reto;
}

/* Lee el id del usuario sin gastar el reto (para pintar la página y reintentar). */
export function retoCambio(reto: string | undefined): string | null {
	if (!reto) return null;
	const v = retosCambio.get(reto);
	if (!v) return null;
	if (v.caduca < Date.now()) {
		retosCambio.delete(reto);
		return null;
	}
	return v.id;
}

export function cerrarRetoCambio(reto: string | undefined) {
	if (reto) retosCambio.delete(reto);
}

/* Lo que le falta a un usuario para poder entrar: cambiar la contraseña, poner un correo o las dos. */
export async function pendientesAlEntrar(
	id: string
): Promise<{ usuario: string; clave: boolean; correo: boolean } | null> {
	const [u] = await db
		.select({
			usuario: s.usuariosLocales.usuario,
			debeCambiar: s.usuariosLocales.debeCambiar,
			correo: s.usuariosLocales.correo
		})
		.from(s.usuariosLocales)
		.where(eq(s.usuariosLocales.id, id));
	return u ? { usuario: u.usuario, clave: u.debeCambiar, correo: !correoValido(u.correo) } : null;
}

/* Fija el correo de recuperación de un usuario (el suyo propio o el forzado al entrar). */
/* ¿Es esta la contraseña de ahora de ese usuario? Para lo que se pide con la sesión abierta y además la contraseña. */
export async function claveCorrecta(id: string, clave: string): Promise<boolean> {
	return (await claveConFreno(id, clave)) === 'bien';
}

/*
 * La contraseña actual, con el mismo freno que la entrada: cada intento cuenta y,
 * bloqueado, ni se mira. Si no, con una sesión abierta se podría adivinar la
 * contraseña sin límite desde el cambio de correo o de contraseña.
 */
async function claveConFreno(
	id: string,
	clave: string
): Promise<'bien' | 'mal' | 'bloqueado' | 'no-existe'> {
	const [u] = await db
		.select({ claveHash: s.usuariosLocales.claveHash })
		.from(s.usuariosLocales)
		.where(eq(s.usuariosLocales.id, id));
	if (!u) return 'no-existe';
	if (!(await gastarIntento(id, Date.now()))) return 'bloqueado';
	if (!(await comprobarClaveAsync(clave, u.claveHash))) return 'mal';
	await db
		.update(s.usuariosLocales)
		.set({ intentosFallidos: 0, bloqueadoHasta: null })
		.where(eq(s.usuariosLocales.id, id));
	return 'bien';
}

export async function cambiarCorreo(
	quien: string,
	id: string,
	correo: string
): Promise<{ ok: true; identidad: Identidad } | { ok: false; error: string }> {
	const limpio = correo.trim();
	if (!correoValido(limpio))
		return { ok: false, error: 'Enter a valid email address, such as name@company.com.' };
	const [u] = await db
		.update(s.usuariosLocales)
		.set({ correo: limpio })
		.where(eq(s.usuariosLocales.id, id))
		.returning();
	if (!u) return { ok: false, error: 'The user no longer exists.' };
	await auditar(quien, 'recovery email changed', { usuario: u.usuario });
	return { ok: true, identidad: identidadDe(u) };
}

/*
 * Cierra las sesiones abiertas de un usuario local (salvo, si se dice, la de quien
 * hace el cambio): al cambiarle o restablecerle la contraseña o al quitarlo, quien
 * tuviera una sesión abierta con la contraseña de antes ya no sigue dentro.
 */
export async function cerrarSesionesDe(
	id: string,
	salvo?: string,
	bd: Pick<typeof db, 'update'> = db
) {
	await bd
		.update(s.sesiones)
		.set({ cerrada: new Date() })
		.where(
			and(
				eq(s.sesiones.oid, `local:${id}`),
				isNull(s.sesiones.cerrada),
				...(salvo ? [ne(s.sesiones.id, salvo)] : [])
			)
		);
}

export async function cambiarClave(
	id: string,
	nueva: string
): Promise<{ ok: true; identidad: Identidad } | { ok: false; error: string }> {
	if (nueva.length < MIN_CLAVE)
		return { ok: false, error: `The password needs at least ${MIN_CLAVE} characters.` };
	const [u] = await db
		.update(s.usuariosLocales)
		.set({
			claveHash: hashClave(nueva),
			debeCambiar: false,
			intentosFallidos: 0,
			bloqueadoHasta: null
		})
		.where(eq(s.usuariosLocales.id, id))
		.returning();
	if (!u) return { ok: false, error: 'The user no longer exists.' };
	await cerrarSesionesDe(id);
	return { ok: true, identidad: identidadDe(u) };
}

/* ---------- autogestión (el propio usuario, login local) ---------- */

/*
 * El usuario cambia su PROPIA contraseña: pide la actual y la comprueba antes de
 * tocar nada (al revés que cambiarClave, que es para el cambio forzado tras un
 * restablecimiento y NO pide la actual). No toca roles ni bloqueo.
 */
export async function cambiarClavePropia(
	quien: string,
	id: string,
	actual: string,
	nueva: string,
	sesionActual?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (nueva.length < MIN_CLAVE)
		return { ok: false, error: `The password needs at least ${MIN_CLAVE} characters.` };
	if (nueva === actual)
		return { ok: false, error: 'The new password must be different from the current one.' };
	const r = await claveConFreno(id, actual);
	if (r === 'no-existe') return { ok: false, error: 'The user no longer exists.' };
	if (r === 'bloqueado')
		return { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };
	if (r === 'mal') return { ok: false, error: 'The current password is incorrect.' };
	await db
		.update(s.usuariosLocales)
		.set({ claveHash: hashClave(nueva), debeCambiar: false })
		.where(eq(s.usuariosLocales.id, id));
	/* Las demás sesiones suyas se cierran: si alguien más tenía una, ya no. */
	await cerrarSesionesDe(id, sesionActual);
	/* En la auditoría no va la contraseña, claro: solo que la cambió él mismo. */
	await auditar(quien, 'own password changed');
	return { ok: true };
}

/* El usuario cambia su propio nombre mostrado (no el de usuario de la entrada). */
export async function cambiarNombrePropio(
	quien: string,
	id: string,
	nombre: string
): Promise<{ ok: true; nombre: string } | { ok: false; error: string }> {
	const limpio = nombre.trim();
	if (!limpio) return { ok: false, error: 'The name cannot be empty.' };
	if (limpio.length > 80) return { ok: false, error: 'The name is too long (maximum 80).' };
	const [u] = await db
		.update(s.usuariosLocales)
		.set({ nombre: limpio })
		.where(eq(s.usuariosLocales.id, id))
		.returning({ id: s.usuariosLocales.id });
	if (!u) return { ok: false, error: 'The user no longer exists.' };
	await auditar(quien, 'own name changed');
	return { ok: true, nombre: limpio };
}

/* ---------- gestión (desde la consola, solo admin) ---------- */

export const listar = () =>
	db
		.select({
			id: s.usuariosLocales.id,
			usuario: s.usuariosLocales.usuario,
			nombre: s.usuariosLocales.nombre,
			correo: s.usuariosLocales.correo,
			roles: s.usuariosLocales.roles,
			debeCambiar: s.usuariosLocales.debeCambiar,
			bloqueadoHasta: s.usuariosLocales.bloqueadoHasta,
			creada: s.usuariosLocales.creada,
			ultimoAcceso: s.usuariosLocales.ultimoAcceso
		})
		.from(s.usuariosLocales)
		.orderBy(s.usuariosLocales.usuario);

export const hayUsuarios = async () =>
	(await db.select({ id: s.usuariosLocales.id }).from(s.usuariosLocales).limit(1)).length > 0;

function limpiarRoles(roles: string[]): Rol[] {
	return [...new Set(roles.filter((r): r is Rol => (ROLES as readonly string[]).includes(r)))];
}

export async function crear(
	quien: string,
	datos: { usuario: string; nombre: string; correo: string; roles: string[]; clave: string }
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const usuario = norma(datos.usuario);
	if (!usuarioValido(usuario))
		return {
			ok: false,
			error:
				'The username must be 3 to 32 characters: letters, numbers, dots, hyphens or underscores.'
		};
	if (!correoValido(datos.correo))
		return {
			ok: false,
			error:
				'An email address is required (name@company.com): the code is sent there if the password is lost.'
		};
	if (datos.clave.length < MIN_CLAVE)
		return { ok: false, error: `The password needs at least ${MIN_CLAVE} characters.` };
	const roles = limpiarRoles(datos.roles);
	if (roles.length === 0) return { ok: false, error: 'Assign at least one role.' };
	const id = randomUUID();
	try {
		await db.insert(s.usuariosLocales).values({
			id,
			usuario,
			nombre: datos.nombre.trim() || usuario,
			correo: datos.correo.trim(),
			claveHash: hashClave(datos.clave),
			roles,
			debeCambiar: true,
			creadaPor: quien
		});
	} catch {
		return { ok: false, error: 'A user with that name already exists.' };
	}
	await auditar(quien, 'local user created', { usuario, roles });
	return { ok: true, id };
}

/*
 * La guarda de «no quedarse sin ningún administrador» se comprueba y se aplica
 * dentro de la MISMA transacción, bloqueando las filas (`for update`): así dos
 * peticiones a la vez (quitar admin a uno y retirar al otro) se serializan y no
 * pueden dejar el nodo con cero administradores entre las dos.
 */

export async function fijarRoles(
	quien: string,
	id: string,
	roles: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
	const limpios = limpiarRoles(roles);
	if (limpios.length === 0) return { ok: false, error: 'Leave at least one role.' };
	const r = await db.transaction(async (tx) => {
		const filas = await tx
			.select({ id: s.usuariosLocales.id, roles: s.usuariosLocales.roles })
			.from(s.usuariosLocales)
			.for('update');
		const actual = filas.find((f) => f.id === id);
		if (!actual) return { ok: false as const, error: 'That user no longer exists.' };
		const admins = filas.filter((f) => f.roles.includes('admin')).length;
		if (actual.roles.includes('admin') && !limpios.includes('admin') && admins <= 1)
			return {
				ok: false as const,
				error:
					'This is the only local administrator: make someone else an administrator before removing admin.'
			};
		await tx.update(s.usuariosLocales).set({ roles: limpios }).where(eq(s.usuariosLocales.id, id));
		return { ok: true as const };
	});
	if (r.ok) await auditar(quien, 'local user roles changed', { id, roles: limpios });
	return r;
}

export async function restablecer(
	quien: string,
	id: string,
	clave: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (clave.length < MIN_CLAVE)
		return { ok: false, error: `The password needs at least ${MIN_CLAVE} characters.` };
	const [u] = await db
		.update(s.usuariosLocales)
		.set({
			claveHash: hashClave(clave),
			debeCambiar: true,
			intentosFallidos: 0,
			bloqueadoHasta: null
		})
		.where(eq(s.usuariosLocales.id, id))
		.returning({ usuario: s.usuariosLocales.usuario });
	if (!u) return { ok: false, error: 'That user no longer exists.' };
	await cerrarSesionesDe(id);
	await auditar(quien, 'local user password reset', { usuario: u.usuario });
	return { ok: true };
}

export async function retirar(
	quien: string,
	id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	const r = await db.transaction(async (tx) => {
		const filas = await tx
			.select({
				id: s.usuariosLocales.id,
				roles: s.usuariosLocales.roles,
				usuario: s.usuariosLocales.usuario
			})
			.from(s.usuariosLocales)
			.for('update');
		const u = filas.find((f) => f.id === id);
		if (!u) return { ok: false as const, error: 'That user no longer exists.' };
		const admins = filas.filter((f) => f.roles.includes('admin')).length;
		if (u.roles.includes('admin') && admins <= 1)
			return {
				ok: false as const,
				error: 'This is the only local administrator: it cannot be removed.'
			};
		await tx.delete(s.usuariosLocales).where(eq(s.usuariosLocales.id, id));
		await cerrarSesionesDe(id, undefined, tx);
		await tx.delete(s.preferenciasUsuario).where(eq(s.preferenciasUsuario.oid, `local:${id}`));
		return { ok: true as const, usuario: u.usuario };
	});
	if (r.ok) await auditar(quien, 'local user removed', { usuario: r.usuario });
	return r.ok ? { ok: true } : r;
}
