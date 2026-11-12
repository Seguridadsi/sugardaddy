/* Los números de la métrica de ruido (lib/ruido.ts), por honeypot. */
import { sql } from 'drizzle-orm';
import type { RuidoDeTrampa } from '$lib/ruido';
import { db, schema as s } from './db';

export const DIAS_RUIDO = 30;

export async function ruidoPorTrampa(dias = DIAS_RUIDO): Promise<RuidoDeTrampa[]> {
	const desde = new Date(Date.now() - dias * 86_400_000);
	const filas = await db.execute<{
		id: string;
		nombre: string;
		modulo: string;
		eventos: number;
		escaner: number;
		falsos: number;
		confirmados: number;
	}>(sql`
		select t.id, t.nombre, t.modulo,
			count(e.id)::int as eventos,
			count(e.id) filter (where e.escaner is not null)::int as escaner,
			count(e.id) filter (where tr.estado = 'falso-positivo' and e.escaner is null)::int as falsos,
			count(e.id) filter (where tr.estado = 'interesante')::int as confirmados
		from ${s.trampas} t
		left join ${s.eventos} e
			on e.trampa = t.id and e.recibido >= ${desde.toISOString()}::timestamptz and not e.prueba
		left join ${s.triaje} tr on tr.evento = e.id
		group by t.id, t.nombre, t.modulo
		order by t.nombre
	`);
	return [...filas].map((f) => ({
		id: f.id,
		nombre: f.nombre,
		modulo: f.modulo,
		eventos: f.eventos,
		escaner: f.escaner,
		falsosPositivos: f.falsos,
		confirmados: f.confirmados
	}));
}
