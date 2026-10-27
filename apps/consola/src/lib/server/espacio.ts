/*
 * El espacio que ocupan los eventos y a qué ritmo crecen, para que el cliente
 * lo vea en Ajustes y decida el plazo de conservación con criterio. No se mide
 * el disco de la máquina (desde el contenedor no es fiable), pero no hace falta:
 * con un plazo de conservación los eventos NO crecen sin fin, se estabilizan en
 * «ritmo × plazo». Eso es lo que se estima aquí.
 */
import { sql } from 'drizzle-orm';
import { db } from './db';

export type EstadoEspacio = {
	/* Tamaño de toda la base de la consola (bytes). */
	baseBytes: number;
	/* Tamaño de la tabla de eventos con sus índices (bytes). */
	eventosBytes: number;
	/* Cuántos eventos hay, y cuántos en los últimos 30 días. */
	eventos: number;
	eventosMes: number;
	masViejo: string | null;
	masNuevo: string | null;
};

export async function estadoEspacio(): Promise<EstadoEspacio> {
	const filas = await db.execute<{
		base: string;
		eventos_bytes: string;
		n: string;
		mes: string;
		viejo: Date | null;
		nuevo: Date | null;
	}>(sql`
		select
			pg_database_size(current_database()) as base,
			pg_total_relation_size('eventos') as eventos_bytes,
			(select count(*) from eventos) as n,
			(select count(*) from eventos where recibido > now() - interval '30 days') as mes,
			(select min(recibido) from eventos) as viejo,
			(select max(recibido) from eventos) as nuevo
	`);
	const r = filas[0];
	return {
		baseBytes: Number(r?.base ?? 0),
		eventosBytes: Number(r?.eventos_bytes ?? 0),
		eventos: Number(r?.n ?? 0),
		eventosMes: Number(r?.mes ?? 0),
		masViejo: r?.viejo ? new Date(r.viejo).toISOString() : null,
		masNuevo: r?.nuevo ? new Date(r.nuevo).toISOString() : null
	};
}

/*
 * A partir del estado y del plazo, lo que el cliente quiere saber: a este ritmo,
 * cuántos eventos entran al mes y en qué tamaño se estabilizará la base con el
 * plazo puesto (no crece más). bytesPorEvento sale del tamaño real / nº de
 * eventos; si aún no hay eventos, no se puede estimar.
 */
export function estimacion(e: EstadoEspacio, plazoDias: number) {
	const bytesPorEvento = e.eventos > 0 ? e.eventosBytes / e.eventos : 0;
	const ritmoDia = e.eventosMes / 30;
	const eventosEnPlazo = Math.round(ritmoDia * plazoDias);
	return {
		bytesPorEvento,
		ritmoDia,
		eventosMes: e.eventosMes,
		/* Eventos y tamaño en los que se estabiliza la base con este plazo. */
		eventosEnPlazo,
		bytesEnPlazo: Math.round(eventosEnPlazo * bytesPorEvento),
		/* Si hay pocos datos (menos de un día de eventos), la estimación es floja. */
		fiable: e.eventosMes >= 50
	};
}
