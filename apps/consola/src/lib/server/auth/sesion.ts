/*
 * Sesiones de la consola, guardadas en Postgres. La cookie lleva solo un id
 * aleatorio de 256 bits; quién eres y qué roles tienes se leen de la tabla en
 * cada petición. En la tabla va el SHA-256 del id (su huella), no el id: quien
 * lea la base (una copia de seguridad, un volcado) no se lleva sesiones que
 * valgan. Como en el panel (apps/central/src/lib/server/sesion.ts).
 *
 * La cookie es `__Host-`: el navegador solo la acepta con Secure, Path=/ y sin
 * Domain, así que nadie la puede fijar desde otro nombre ni por http. SameSite
 * es Lax y no Strict: al volver de Microsoft (entrada con Entra) la navegación
 * empieza en otro sitio y con Strict la primera página saldría sin sesión. Las
 * acciones de formulario ya las protege la comprobación de origen de SvelteKit.
 */
import { createHash, randomBytes } from 'node:crypto';
import { redirect, type Cookies } from '@sveltejs/kit';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema as s } from '../db';
import type { Identidad } from './entra';
import { abierto } from '../soporte';
import { apuntarEntrada } from '../revision-accesos';
import { ROLES, type Rol } from './permisos';

export const COOKIE_SESION = '__Host-sd_sesion';
/*
 * La de antes de la 0.30 (sin prefijo y con el id en claro en la base). La
 * migración 0062 pasa sus filas a huella y, la primera vez que llega, se cambia
 * por la nueva: nadie tiene que volver a entrar por la actualización. Ninguna
 * sesión dura más de ocho horas, así que esto se puede quitar en la siguiente.
 */
const COOKIE_ANTIGUA = 'sd_sesion';
const ID_VALIDO = /^[A-Za-z0-9_-]{43}$/;
/* Media hora sin hacer nada y fuera; ocho horas como mucho aunque no pares. */
export const INACTIVIDAD_MS = 30 * 60_000;
export const MAXIMO_MS = 8 * 60 * 60_000;
/* Una entrada de emergencia dura como mucho una hora: es para salir del apuro, no para trabajar. */
export const MAXIMO_EMERGENCIA_MS = 60 * 60_000;

/* Lo que se guarda en la tabla: SHA-256 del id de la cookie, en hex. */
export const huella = (id: string) => createHash('sha256').update(id).digest('hex');

function ponerCookie(cookies: Cookies, id: string, maxAge = MAXIMO_MS / 1000) {
	cookies.set(COOKIE_SESION, id, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		maxAge
	});
}

function quitarCookies(cookies: Cookies) {
	cookies.delete(COOKIE_SESION, { path: '/', secure: true });
	if (cookies.get(COOKIE_ANTIGUA)) cookies.delete(COOKIE_ANTIGUA, { path: '/' });
}

/* El id de la cookie (la nueva o, si no está, la de antes) y si venía en la de antes. */
function idDeCookie(cookies: Cookies): { id: string; antigua: boolean } | null {
	const nueva = cookies.get(COOKIE_SESION);
	if (nueva) return ID_VALIDO.test(nueva) ? { id: nueva, antigua: false } : null;
	const vieja = cookies.get(COOKIE_ANTIGUA);
	return vieja && ID_VALIDO.test(vieja) ? { id: vieja, antigua: true } : null;
}

/* ¿Trae la petición alguna cookie de sesión (valga o no)? */
export const traeSesion = (cookies: Cookies) =>
	!!(cookies.get(COOKIE_SESION) || cookies.get(COOKIE_ANTIGUA));

/* La huella de la sesión de esta petición, para «todas menos esta». */
export function sesionActual(cookies: Cookies): string | null {
	const c = idDeCookie(cookies);
	return c ? huella(c.id) : null;
}

/* `factor`: el segundo factor con el que se entró, si se comprobó alguno (segundo-factor.ts). */
export async function abrir(cookies: Cookies, identidad: Identidad, factor: string | null = null) {
	/* Una cuenta desactivada (por inactividad o a mano, revision-accesos.ts) no entra, venga de donde venga. */
	if (!(await apuntarEntrada(identidad))) redirect(303, '/sign-in?error=desactivada');
	const id = randomBytes(32).toString('base64url');
	await db.insert(s.sesiones).values({ id: huella(id), ...identidad, factor });
	ponerCookie(cookies, id);
	if (cookies.get(COOKIE_ANTIGUA)) cookies.delete(COOKIE_ANTIGUA, { path: '/' });
	return id;
}

/* ¿Sigue configurado el OIDC propio? Es la clave AJUSTE_OIDC de oidc-propio.ts. */
async function proveedorOidc() {
	const [f] = await db
		.select({ clave: s.ajustes.clave })
		.from(s.ajustes)
		.where(eq(s.ajustes.clave, 'oidc_propio'));
	return !!f;
}

export async function leer(cookies: Cookies, ahora = Date.now()) {
	const c = idDeCookie(cookies);
	if (!c) {
		if (traeSesion(cookies)) quitarCookies(cookies);
		return null;
	}
	const id = huella(c.id);
	const [fila] = await db
		.select()
		.from(s.sesiones)
		.where(
			and(
				eq(s.sesiones.id, id),
				isNull(s.sesiones.cerrada),
				gt(s.sesiones.ultimaActividad, new Date(ahora - INACTIVIDAD_MS)),
				gt(s.sesiones.creada, new Date(ahora - MAXIMO_MS))
			)
		);
	const emergencia = !!fila?.oid.startsWith('emergencia:');
	/*
	 * Una sesión abierta con el OIDC propio vale mientras ese proveedor siga
	 * configurado: si se quita, se acaba (auditoría 2026-11-23 §4.7). quitarOidc ya
	 * las cierra; esto cubre lo que se le escape (un borrado a mano, una carrera).
	 * Se lee el ajuste directamente para no importar oidc-propio.ts aquí.
	 */
	if (fila?.oid.startsWith('oidc:') && !(await proveedorOidc())) {
		await db
			.update(s.sesiones)
			.set({ cerrada: new Date(ahora) })
			.where(eq(s.sesiones.id, id));
		quitarCookies(cookies);
		return null;
	}
	/* Una sesión de soporte vale lo que dure el soporte: si el cliente lo cierra, se acaba. */
	if (
		!fila ||
		(fila.soporte && !(await abierto())) ||
		(emergencia && ahora - fila.creada.getTime() > MAXIMO_EMERGENCIA_MS)
	) {
		quitarCookies(cookies);
		return null;
	}
	/* Venía en la cookie de antes: pasa a la nueva, con lo que le quede de vida. */
	if (c.antigua) {
		const resto = Math.ceil((fila.creada.getTime() + MAXIMO_MS - ahora) / 1000);
		ponerCookie(cookies, c.id, Math.max(resto, 1));
		cookies.delete(COOKIE_ANTIGUA, { path: '/' });
	}
	/*
	 * Un usuario local: sus roles de AHORA, no los que tenía al entrar, y si ya no
	 * existe, no hay sesión. Antes, quitar a alguien o bajarle de administrador no
	 * le afectaba hasta que su sesión caducaba (hasta 8 horas): tiempo de sobra
	 * para crearse otro administrador.
	 */
	let roles = fila.roles;
	if (fila.oid.startsWith('local:')) {
		const [u] = await db
			.select({ roles: s.usuariosLocales.roles })
			.from(s.usuariosLocales)
			.where(eq(s.usuariosLocales.id, fila.oid.slice('local:'.length)));
		if (!u) {
			await db
				.update(s.sesiones)
				.set({ cerrada: new Date(ahora) })
				.where(eq(s.sesiones.id, id));
			quitarCookies(cookies);
			return null;
		}
		roles = u.roles.filter((r): r is Rol => (ROLES as readonly string[]).includes(r));
	}
	await db
		.update(s.sesiones)
		.set({ ultimaActividad: new Date(ahora) })
		.where(eq(s.sesiones.id, id));
	return {
		nombre: fila.nombre,
		correo: fila.correo,
		roles,
		oid: fila.oid,
		sesion: fila.id,
		soporte: fila.soporte,
		emergencia
	};
}

/*
 * Cambia el nombre mostrado en las sesiones ABIERTAS de un oid. Lo usa la
 * autogestión: así la barra enseña el nombre nuevo en la siguiente petición sin
 * tener que volver a entrar (no toca la identidad, solo lo que se pinta).
 */
export async function renombrarSesiones(oid: string, nombre: string) {
	await db
		.update(s.sesiones)
		.set({ nombre })
		.where(and(eq(s.sesiones.oid, oid), isNull(s.sesiones.cerrada)));
}

export async function cambiarCorreoSesiones(oid: string, correo: string) {
	await db
		.update(s.sesiones)
		.set({ correo })
		.where(and(eq(s.sesiones.oid, oid), isNull(s.sesiones.cerrada)));
}

/* Devuelve el oid de la sesión cerrada (o null): quien llama decide a dónde mandar al salir. */
export async function cerrar(cookies: Cookies): Promise<string | null> {
	const id = sesionActual(cookies);
	let oid: string | null = null;
	if (id) {
		const [fila] = await db
			.update(s.sesiones)
			.set({ cerrada: new Date() })
			.where(eq(s.sesiones.id, id))
			.returning({ oid: s.sesiones.oid });
		oid = fila?.oid ?? null;
	}
	quitarCookies(cookies);
	return oid;
}
