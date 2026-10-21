/*
 * Sesiones de la consola, guardadas en Postgres. La cookie lleva solo un id
 * aleatorio de 256 bits; quién eres y qué roles tienes se leen de la tabla en
 * cada petición.
 */
import { randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema as s } from '../db';
import type { Identidad } from './entra';
import { abierto } from '../soporte';

export const COOKIE_SESION = 'sd_sesion';
/* Media hora sin hacer nada y fuera; ocho horas como mucho aunque no pares. */
export const INACTIVIDAD_MS = 30 * 60_000;
export const MAXIMO_MS = 8 * 60 * 60_000;
/* Una entrada de emergencia dura como mucho una hora: es para salir del apuro, no para trabajar. */
export const MAXIMO_EMERGENCIA_MS = 60 * 60_000;

export async function abrir(cookies: Cookies, identidad: Identidad, seguro: boolean) {
	const id = randomBytes(32).toString('base64url');
	await db.insert(s.sesiones).values({ id, ...identidad });
	cookies.set(COOKIE_SESION, id, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: seguro,
		maxAge: MAXIMO_MS / 1000
	});
	return id;
}

export async function leer(cookies: Cookies, ahora = Date.now()) {
	const id = cookies.get(COOKIE_SESION);
	if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
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
	/* Una sesión de soporte vale lo que dure el soporte: si el cliente lo cierra, se acaba. */
	if (
		!fila ||
		(fila.soporte && !(await abierto())) ||
		(emergencia && ahora - fila.creada.getTime() > MAXIMO_EMERGENCIA_MS)
	) {
		cookies.delete(COOKIE_SESION, { path: '/' });
		return null;
	}
	await db
		.update(s.sesiones)
		.set({ ultimaActividad: new Date(ahora) })
		.where(eq(s.sesiones.id, id));
	return {
		nombre: fila.nombre,
		correo: fila.correo,
		roles: fila.roles,
		sesion: fila.id,
		soporte: fila.soporte,
		emergencia
	};
}

export async function cerrar(cookies: Cookies) {
	const id = cookies.get(COOKIE_SESION);
	if (id) await db.update(s.sesiones).set({ cerrada: new Date() }).where(eq(s.sesiones.id, id));
	cookies.delete(COOKIE_SESION, { path: '/' });
}
