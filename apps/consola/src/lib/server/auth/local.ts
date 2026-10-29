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
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { eq, sql } from 'drizzle-orm';
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

export function loginLocalHabilitado() {
	return env.LOGIN_LOCAL === '1' || env.EDICION === 'community';
}

/* ---------- hash de contraseñas (scrypt) ---------- */

export function hashClave(clave: string): string {
	const sal = randomBytes(16);
	const h = scryptSync(clave, sal, LONGITUD, { N, r: R, p: P, maxmem: MAXMEM });
	return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${h.toString('base64')}`;
}

export function comprobarClave(clave: string, almacenado: string): boolean {
	const p = almacenado.split('$');
	if (p.length !== 6 || p[0] !== 'scrypt') return false;
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
		return false;
	const sal = Buffer.from(p[4], 'base64');
	const esperado = Buffer.from(p[5], 'base64');
	if (sal.length === 0 || esperado.length === 0) return false;
	let h: Buffer;
	try {
		h = scryptSync(clave, sal, esperado.length, { N: n, r, p: q, maxmem: MAXMEM });
	} catch {
		return false;
	}
	return h.length === esperado.length && timingSafeEqual(h, esperado);
}

/*
 * Un hash de descarte, para gastar el mismo tiempo cuando el usuario no existe:
 * así no se distingue «usuario desconocido» de «contraseña mala» por el reloj.
 */
const HASH_FALSO = hashClave(randomBytes(18).toString('base64url'));

/* ---------- entrada ---------- */

export type ResultadoEntrada =
	| { ok: true; identidad: Identidad; id: string; debeCambiar: boolean }
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
 * Suma un intento fallido de forma ATÓMICA (intentos = intentos + 1 en la propia
 * base) y, si llega al umbral, fija el bloqueo según el valor REAL ya
 * incrementado. Hacerlo en SQL y no leer-sumar-escribir en JS es lo que impide
 * que varios intentos a la vez lean el mismo valor viejo y diluyan el freno.
 */
async function registrarFallo(id: string) {
	const [fila] = await db
		.update(s.usuariosLocales)
		.set({ intentosFallidos: sql`${s.usuariosLocales.intentosFallidos} + 1` })
		.where(eq(s.usuariosLocales.id, id))
		.returning({ fallos: s.usuariosLocales.intentosFallidos });
	const ms = fila ? bloqueoMs(fila.fallos) : 0;
	if (ms)
		await db
			.update(s.usuariosLocales)
			.set({ bloqueadoHasta: new Date(Date.now() + ms) })
			.where(eq(s.usuariosLocales.id, id));
}

export async function verificar(usuario: string, clave: string): Promise<ResultadoEntrada> {
	const nombreU = norma(usuario);
	const [u] = nombreU
		? await db.select().from(s.usuariosLocales).where(eq(s.usuariosLocales.usuario, nombreU))
		: [];
	const ahora = Date.now();

	/* Bloqueado por intentos: ni se mira la contraseña. */
	if (u?.bloqueadoHasta && u.bloqueadoHasta.getTime() > ahora)
		return { ok: false, motivo: 'bloqueado', hasta: u.bloqueadoHasta };

	/* Siempre se calcula un scrypt (con el hash real o con el falso): tiempo constante. */
	const correcto = comprobarClave(clave, u?.claveHash ?? HASH_FALSO) && !!u;

	if (!u || !correcto) {
		if (u) await registrarFallo(u.id);
		return { ok: false, motivo: 'credenciales' };
	}

	await db
		.update(s.usuariosLocales)
		.set({ intentosFallidos: 0, bloqueadoHasta: null, ultimoAcceso: new Date(ahora) })
		.where(eq(s.usuariosLocales.id, u.id));
	return { ok: true, id: u.id, debeCambiar: u.debeCambiar, identidad: identidadDe(u) };
}

/* ---------- cambio de contraseña obligatorio (primer acceso o restablecimiento) ---------- */

/*
 * Un reto de un solo uso para el cambio forzado: al entrar con una contraseña de
 * un solo uso, la consola no abre sesión todavía; guarda aquí el id del usuario
 * y manda a /entrar/cambiar. Vive en memoria y dura poco, como los retos de la
 * entrada de emergencia; si el proceso se reinicia, se vuelve a entrar.
 */
/* La cookie del cambio forzado vive solo bajo /entrar (la leen /entrar y /entrar/cambiar). */
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

export async function cambiarClave(
	id: string,
	nueva: string
): Promise<{ ok: true; identidad: Identidad } | { ok: false; error: string }> {
	if (nueva.length < MIN_CLAVE)
		return { ok: false, error: `La contraseña necesita al menos ${MIN_CLAVE} caracteres.` };
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
	if (!u) return { ok: false, error: 'El usuario ya no existe.' };
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
	nueva: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (nueva.length < MIN_CLAVE)
		return { ok: false, error: `La contraseña necesita al menos ${MIN_CLAVE} caracteres.` };
	if (nueva === actual)
		return { ok: false, error: 'La contraseña nueva tiene que ser distinta de la actual.' };
	const [u] = await db
		.select({ claveHash: s.usuariosLocales.claveHash })
		.from(s.usuariosLocales)
		.where(eq(s.usuariosLocales.id, id));
	if (!u) return { ok: false, error: 'El usuario ya no existe.' };
	if (!comprobarClave(actual, u.claveHash))
		return { ok: false, error: 'La contraseña actual no es correcta.' };
	await db
		.update(s.usuariosLocales)
		.set({ claveHash: hashClave(nueva), debeCambiar: false })
		.where(eq(s.usuariosLocales.id, id));
	/* En la auditoría no va la contraseña, claro: solo que la cambió él mismo. */
	await auditar(quien, 'contraseña propia cambiada');
	return { ok: true };
}

/* El usuario cambia su propio nombre mostrado (no el de usuario de la entrada). */
export async function cambiarNombrePropio(
	quien: string,
	id: string,
	nombre: string
): Promise<{ ok: true; nombre: string } | { ok: false; error: string }> {
	const limpio = nombre.trim();
	if (!limpio) return { ok: false, error: 'El nombre no puede estar vacío.' };
	if (limpio.length > 80) return { ok: false, error: 'El nombre es demasiado largo (máximo 80).' };
	const [u] = await db
		.update(s.usuariosLocales)
		.set({ nombre: limpio })
		.where(eq(s.usuariosLocales.id, id))
		.returning({ id: s.usuariosLocales.id });
	if (!u) return { ok: false, error: 'El usuario ya no existe.' };
	await auditar(quien, 'nombre propio cambiado');
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
			error: 'El usuario lleva de 3 a 32 caracteres: letras, números, punto, guion o guion bajo.'
		};
	if (datos.clave.length < MIN_CLAVE)
		return { ok: false, error: `La contraseña necesita al menos ${MIN_CLAVE} caracteres.` };
	const roles = limpiarRoles(datos.roles);
	if (roles.length === 0) return { ok: false, error: 'Hay que dar al menos un rol.' };
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
		return { ok: false, error: 'Ya hay un usuario con ese nombre.' };
	}
	await auditar(quien, 'usuario local creado', { usuario, roles });
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
	if (limpios.length === 0) return { ok: false, error: 'Hay que dejar al menos un rol.' };
	const r = await db.transaction(async (tx) => {
		const filas = await tx
			.select({ id: s.usuariosLocales.id, roles: s.usuariosLocales.roles })
			.from(s.usuariosLocales)
			.for('update');
		const actual = filas.find((f) => f.id === id);
		if (!actual) return { ok: false as const, error: 'Ese usuario ya no existe.' };
		const admins = filas.filter((f) => f.roles.includes('admin')).length;
		if (actual.roles.includes('admin') && !limpios.includes('admin') && admins <= 1)
			return {
				ok: false as const,
				error: 'Es el único administrador local: deja a otro antes de quitarle admin.'
			};
		await tx.update(s.usuariosLocales).set({ roles: limpios }).where(eq(s.usuariosLocales.id, id));
		return { ok: true as const };
	});
	if (r.ok) await auditar(quien, 'roles de usuario local cambiados', { id, roles: limpios });
	return r;
}

export async function restablecer(
	quien: string,
	id: string,
	clave: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (clave.length < MIN_CLAVE)
		return { ok: false, error: `La contraseña necesita al menos ${MIN_CLAVE} caracteres.` };
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
	if (!u) return { ok: false, error: 'Ese usuario ya no existe.' };
	await auditar(quien, 'contraseña de usuario local restablecida', { usuario: u.usuario });
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
		if (!u) return { ok: false as const, error: 'Ese usuario ya no existe.' };
		const admins = filas.filter((f) => f.roles.includes('admin')).length;
		if (u.roles.includes('admin') && admins <= 1)
			return { ok: false as const, error: 'Es el único administrador local: no se puede retirar.' };
		await tx.delete(s.usuariosLocales).where(eq(s.usuariosLocales.id, id));
		return { ok: true as const, usuario: u.usuario };
	});
	if (r.ok) await auditar(quien, 'usuario local retirado', { usuario: r.usuario });
	return r.ok ? { ok: true } : r;
}
