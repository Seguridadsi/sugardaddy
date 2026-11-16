/*
 * La política de cambios del nodo y la aprobación de cada versión, guardadas en ajustes
 * (docs/diseno/politica-cambios.md). La cuenta está en $lib/politica-actualizacion.ts; aquí,
 * leer, guardar y auditar (auditoria.actualizacion: las acciones empiezan por «update »).
 *
 * El panel no puede tocar nada de esto: el estado deseado no trae ajustes de la consola. Y aun
 * así, quien decide es el actualizador con su propio suelo (.env).
 */
import { eq } from 'drizzle-orm';
import { db, schema as s } from './db';
import { auditar } from './consultas';
import {
	datosDeRelease,
	esperaDe,
	leerPolitica,
	type AprobacionActualizacion,
	type Espera,
	type PoliticaActualizacion
} from '$lib/politica-actualizacion';

const CLAVE_POLITICA = 'politica-actualizacion';
const CLAVE_APROBACION = 'aprobacion-actualizacion';

/* Lo que hace falta de la actualización pendiente (canal.ts). */
type Pendiente = {
	estado: 'al-dia' | 'pendiente' | 'aplicando' | 'fallida';
	version: string | null;
	release: { release: string } | null;
};

async function leerAjuste(clave: string): Promise<unknown> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return f?.valor ?? null;
}

async function guardarAjuste(clave: string, valor: unknown) {
	await db
		.insert(s.ajustes)
		.values({ clave, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export async function politicaActualizacion(): Promise<PoliticaActualizacion> {
	return leerPolitica(await leerAjuste(CLAVE_POLITICA));
}

export async function guardarPoliticaActualizacion(quien: string, p: PoliticaActualizacion) {
	const antes = await politicaActualizacion();
	if (antes.modo === p.modo && antes.retardoHoras === p.retardoHoras) return false;
	await guardarAjuste(CLAVE_POLITICA, p);
	await auditar(quien, 'update policy changed', { antes, ahora: p });
	return true;
}

export async function aprobacionActualizacion(): Promise<AprobacionActualizacion | null> {
	const v = (await leerAjuste(CLAVE_APROBACION)) as AprobacionActualizacion | null;
	return v && typeof v.version === 'string' && typeof v.quien === 'string' ? v : null;
}

export type ResultadoAprobar = 'aprobada' | 'ya-aprobada' | 'no-pendiente';

/* Aprueba la versión pendiente, solo si es esa: lo que se vio en pantalla es lo que se aprueba. */
export async function aprobarActualizacion(
	quien: string,
	version: string,
	a: Pendiente,
	ahora = new Date()
): Promise<ResultadoAprobar> {
	if (a.estado !== 'pendiente' || a.version !== version || !a.release) return 'no-pendiente';
	const previa = await aprobacionActualizacion();
	if (previa?.version === version) return 'ya-aprobada';
	const datos = datosDeRelease(a.release.release);
	await guardarAjuste(CLAVE_APROBACION, {
		version,
		quien,
		cuando: ahora.toISOString()
	} satisfies AprobacionActualizacion);
	await auditar(quien, 'update approved', {
		version,
		publicada: datos?.publicada ?? null,
		urgente: datos?.urgente ?? false,
		politica: await politicaActualizacion()
	});
	return 'aprobada';
}

/* Por qué espera la versión pendiente, si espera. Una que ya se está aplicando no espera. */
export async function esperaActual(a: Pendiente, ahora = Date.now()): Promise<Espera> {
	if (a.estado !== 'pendiente' || !a.release) return { motivo: null };
	const datos = datosDeRelease(a.release.release);
	if (!datos) return { motivo: null };
	return esperaDe(datos, await politicaActualizacion(), await aprobacionActualizacion(), ahora);
}
