/*
 * Lee de la base lo que hace falta para el mapa del despliegue (mapa-despliegue-armar.ts).
 */
import { eq, sql } from 'drizzle-orm';
import { avisosSensor, resumenMotor } from '$lib/capacidades';
import { plataformaDe } from '$lib/destinos';
import type { Mapa } from '$lib/mapa-despliegue';
import { honeycosas } from './catalogo';
import { estadosVisibles } from './colocacion';
import { db, schema as s } from './db';
import { hechosDe } from './hechos';
import { armarMapa } from './mapa-despliegue-armar';

const DIA = 24 * 60 * 60_000;

const direccionesDe = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export async function mapaDespliegue(origen: { host: string; puerto: number }): Promise<Mapa> {
	const ahora = Date.now();
	const desde = new Date(ahora - DIA);
	const [sensoresFilas, destinosFilas, trampas, balizas, rele, estados] = await Promise.all([
		db.select().from(s.sensores).orderBy(s.sensores.creado),
		db.select().from(s.destinos).orderBy(s.destinos.creado),
		db
			.select({
				id: s.trampas.id,
				nombre: s.trampas.nombre,
				modulo: s.trampas.modulo,
				tipo: s.trampas.tipo,
				sensor: s.trampas.sensor,
				destino: s.trampas.destino,
				via: s.trampas.via,
				parametros: s.trampas.parametros,
				donde: s.trampas.donde,
				senalTrampa: s.trampas.senalTrampa,
				/* "trampas"."id" con su tabla: drizzle escribiría ${s.trampas.id} como "id" a secas, el de eventos. */
				eventos: sql<number>`(select count(*)::int from ${s.eventos} e where e.trampa = "trampas"."id" and e.cuando >= ${desde.toISOString()}::timestamptz and e.escaner is null)`
			})
			.from(s.trampas)
			.orderBy(s.trampas.creado),
		db
			.select({
				trampa: s.balizas.trampa,
				clase: s.balizas.clase,
				url: s.balizas.url,
				receptor: s.balizas.receptor
			})
			.from(s.balizas),
		db.select({ valor: s.ajustes.valor }).from(s.ajustes).where(eq(s.ajustes.clave, 'rele')),
		estadosVisibles(ahora)
	]);
	const sensorDe = new Map(sensoresFilas.map((x) => [x.id, x]));
	const dominioRele = rele[0]?.valor;
	return armarMapa({
		ahora,
		origen,
		sensores: sensoresFilas.map((x) => ({
			...x,
			ips: direccionesDe(x.capacidades?.hechos?.['red.direcciones']?.valor).slice(0, 8),
			plataforma: plataformaDe(hechosDe({ descripcion: {} }, x)),
			/* De «Docker 27.1 · rootful · amd64 · API 1.47», solo el motor y su versión. */
			motor: resumenMotor(x.capacidades?.motor)?.split(' · ')[0] ?? null,
			avisos: avisosSensor(x.capacidades).map((a) => a.titulo)
		})),
		destinos: destinosFilas.map((d) => ({
			...d,
			plataforma: plataformaDe(hechosDe(d, d.sensor ? (sensorDe.get(d.sensor) ?? null) : null))
		})),
		trampas,
		balizas,
		estados,
		catalogo: new Map(honeycosas().map((h) => [h.id, h])),
		rele: typeof dominioRele === 'string' && dominioRele.trim() ? dominioRele.trim() : null
	});
}
