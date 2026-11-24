/*
 * Los secretos marcados en este nodo (marca-secretos.ts): la clave de cada
 * trampa para el plan del sensor, y, al recibir un evento, si lleva un secreto
 * que repartió alguna trampa y a quién se lo dio.
 *
 * Un secreto marcado que reaparece es alerta en cualquier trampa, como una
 * credencial cebo: abre incidente ya (incidentes-puntos.ts). El texto dice qué
 * trampa lo dio y a qué dirección, para enlazar las dos sesiones aunque sean
 * IPs distintas.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Evento } from '@sugardaddy/contrato';
import { db, schema as s } from './db';
import { claveDerivada } from './secretos';
import { buscarMarca, claveDeTrampa, huellaVisitante, type MarcaHallada } from './marca-secretos';

/* Las direcciones que se miran para saber a quién se dio: las más recientes de esa trampa. */
const MAX_DIRECCIONES = 5000;

function claveNodo(): Buffer | null {
	return claveDerivada('marca-secretos')?.bytes ?? null;
}

/* La clave (64 hex) que el sensor pasa a la trampa en ${sd.marca}; sin clave del nodo, undefined. */
export function marcaDeTrampa(trampa: string, base = claveNodo()): string | undefined {
	return base ? claveDeTrampa(base, trampa).toString('hex') : undefined;
}

/* El texto del evento donde puede ir un secreto: el detalle entero y el usuario. */
function textoDe(e: Evento): string {
	return `${e.origen.usuario ?? ''}\n${JSON.stringify(e.detalle ?? {})}`;
}

export type Reconocida = MarcaHallada & {
	nombre: string;
	/* La dirección a la que se dio y cuándo la vio la trampa por primera vez; null si ya no está. */
	dadaA: { ip: string; desde: Date } | null;
};

/*
 * Prepara lo de una entrega: las claves de todas las trampas del nodo (también
 * las quitadas: un secreto sigue valiendo después) y una caché de a quién dio
 * cada una. Devuelve con qué mirar cada evento. Sin clave del nodo, no mira nada.
 */
export async function prepararMarcas(base = claveNodo()) {
	if (!base) return async () => null;
	const filas = await db.select({ id: s.trampas.id, nombre: s.trampas.nombre }).from(s.trampas);
	const claves = new Map(filas.map((f) => [f.id, claveDeTrampa(base, f.id)]));
	const nombres = new Map(filas.map((f) => [f.id, f.nombre]));
	const dadas = new Map<string, Reconocida['dadaA']>();

	async function aQuien(m: MarcaHallada): Promise<Reconocida['dadaA']> {
		const clave = `${m.trampa}|${m.visitante}`;
		if (dadas.has(clave)) return dadas.get(clave)!;
		const k = claves.get(m.trampa)!;
		const ips = await db
			.select({
				ip: s.eventos.ip,
				desde: sql<Date>`min(${s.eventos.cuando})`.mapWith((v) => new Date(v))
			})
			.from(s.eventos)
			.where(
				and(eq(s.eventos.trampa, m.trampa), isNotNull(s.eventos.ip), eq(s.eventos.prueba, false))
			)
			.groupBy(s.eventos.ip)
			.orderBy(desc(sql`max(${s.eventos.cuando})`))
			.limit(MAX_DIRECCIONES);
		const hallada = ips.find((f) => f.ip && huellaVisitante(k, f.ip) === m.visitante);
		const r = hallada?.ip ? { ip: hallada.ip, desde: hallada.desde } : null;
		dadas.set(clave, r);
		return r;
	}

	return async (e: Evento): Promise<Reconocida | null> => {
		const m = buscarMarca(textoDe(e), claves);
		if (!m) return null;
		/*
		 * En la misma trampa y desde quien lo recibió no es reaparecer: es la
		 * trampa apuntando que lo entregó, o que su visitante lo usa allí mismo
		 * (eso ya lo puntúa la propia trampa).
		 */
		if (
			m.trampa === e.trampa.id &&
			e.origen.ip &&
			huellaVisitante(claves.get(m.trampa)!, e.origen.ip) === m.visitante
		)
			return null;
		let dadaA: Reconocida['dadaA'] = null;
		try {
			dadaA = await aQuien(m);
		} catch (err) {
			/* Sin saber a quién se dio, la alerta sale igual. */
			console.error('could not look up who received a marked bait secret', err);
		}
		return { ...m, nombre: nombres.get(m.trampa) ?? m.trampa, dadaA };
	};
}

/* El texto de la alerta: qué trampa dio el secreto y a quién. */
export function alertaMarca(r: Reconocida, ipUso: string | null | undefined): string {
	const trampa = `bait secret handed out by the decoy "${r.nombre}"`;
	if (!r.dadaA) return `Used a ${trampa}`;
	const cuando = r.dadaA.desde.toISOString().slice(0, 16).replace('T', ' ');
	if (ipUso && r.dadaA.ip === ipUso)
		return `Used a ${trampa} to this same address (first seen ${cuando} UTC)`;
	return `Used a ${trampa} to ${r.dadaA.ip} (first seen ${cuando} UTC): same attacker or campaign`;
}
