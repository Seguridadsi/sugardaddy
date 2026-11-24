/*
 * La salud de las máquinas de los sensores y de sus trampas
 * (docs/diseno/salud.md): lo que cada sensor manda cada minuto
 * (/api/sensor/salud), guardado 7 días, y los problemas que salen de ello
 * para los avisos de salud (salidas/salud.ts).
 *
 * Umbrales fijos, iguales para todos los nodos:
 *   - disco de datos del sensor: 85 % casi lleno, 95 % lleno;
 *   - memoria: menos del 10 % disponible durante 5 minutos seguidos;
 *   - CPU: más del 90 % durante 15 minutos seguidos;
 *   - una trampa que el motor reinicia 3 veces o más en media hora;
 *   - una trampa que se calla: con 14 eventos o más en la semana anterior,
 *     repartidos en 3 días distintos como poco, y ninguno en las últimas 48
 *     horas. Una que nunca recibe nada no avisa, y tampoco una que solo tuvo
 *     una ráfaga (una prueba, un escaneo de un día): no había tráfico que perder.
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db, schema as s } from './db';
import type { SaludTrampaMuestra } from './db/schema';
import type { LatidoSalud } from '@sugardaddy/canal';

const MINUTO = 60_000;
export const DIAS_SALUD = 7;
export const DISCO_CASI = 0.85;
export const DISCO_LLENO = 0.95;
export const MEMORIA_MINIMA = 0.1;
export const MINUTOS_MEMORIA = 5;
export const CPU_ALTA = 90;
export const MINUTOS_CPU = 15;
export const REINICIOS_BUCLE = 3;
export const MINUTOS_REINICIOS = 30;
export const HORAS_CALLADA = 48;
export const EVENTOS_ANTES_CALLADA = 14;
export const DIAS_ANTES_CALLADA = 3;
/* La tubería: la cola sin quedar al día un cuarto de hora, y el reloj a más de 2 minutos 5 muestras seguidas. */
export const MINUTOS_COLA = 15;
export const RELOJ_MAXIMO = 120;
export const MUESTRAS_RELOJ = 5;
/* Una muestra más vieja que esto no dice cómo está la máquina ahora. */
const VIGENTE = 10 * MINUTO;
/* El sensor manda una por minuto: lo que llegue más deprisa se ignora. */
const ENTRE_MUESTRAS = 30_000;
const MAX_TRAMPAS = 500;
const ESTADOS = new Set([
	'running',
	'restarting',
	'exited',
	'dead',
	'created',
	'paused',
	'removing',
	'unhealthy'
]);

export type Muestra = {
	cuando: Date;
	cpu: number | null;
	carga1: number | null;
	cpus: number | null;
	memoriaTotal: number | null;
	memoriaLibre: number | null;
	discoTotal: number | null;
	discoLibre: number | null;
	trampas: SaludTrampaMuestra[];
	/* La tubería: su cola de salida y su reloj (opcionales: los sensores anteriores no la mandan). */
	colaPendiente?: number | null;
	colaSinEntregar?: number | null;
	colaDescartando?: boolean | null;
	reloj?: number | null;
};

const numero = (x: unknown, max: number): number | null =>
	typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : null;
const ENTERO_BYTES = 2 ** 53;

function capacidad(x: unknown): { total: number; libre: number } | null {
	if (!x || typeof x !== 'object') return null;
	const c = x as Record<string, unknown>;
	const total = numero(c.total, ENTERO_BYTES);
	const libre = numero(c.libre, ENTERO_BYTES);
	if (total === null || libre === null || total === 0 || libre > total) return null;
	return { total: Math.round(total), libre: Math.round(libre) };
}

/*
 * Lo que la consola acepta de un sensor; lo demás se descarta. La hora es la de
 * la consola: un sensor con el reloj mal no desordena la serie.
 */
export function leerMuestra(x: unknown, ahora = new Date()): Muestra | null {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
	const m = x as Record<string, unknown>;
	if (m.v !== 1) return null;
	const mem = capacidad(m.memoria);
	const disco = capacidad(m.disco);
	const trampas: SaludTrampaMuestra[] = [];
	if (Array.isArray(m.trampas))
		for (const t of m.trampas.slice(0, MAX_TRAMPAS)) {
			if (!t || typeof t !== 'object') continue;
			const r = t as Record<string, unknown>;
			if (typeof r.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.id)) continue;
			const reinicios = numero(r.reinicios, 1e9);
			const estado = typeof r.estado === 'string' && ESTADOS.has(r.estado) ? r.estado : 'unknown';
			const desde =
				typeof r.desde === 'string' && !Number.isNaN(Date.parse(r.desde)) && r.desde.length <= 40
					? r.desde
					: undefined;
			trampas.push({
				id: r.id,
				enMarcha: r.enMarcha === true,
				estado,
				reinicios: reinicios === null ? 0 : Math.floor(reinicios),
				...(desde ? { desde } : {})
			});
		}
	const cpus = numero(m.cpus, 4096);
	const cola =
		m.cola && typeof m.cola === 'object' ? (m.cola as Record<string, unknown>) : undefined;
	const pendiente = cola ? numero(cola.pendiente, ENTERO_BYTES) : null;
	const sinEntregar = cola ? numero(cola.sinEntregar, 10 * 365 * 86_400) : null;
	/* El reloj se compara solo si el sensor manda la cola (los anteriores mandan su hora, sin más). */
	const suHora = cola && typeof m.cuando === 'string' ? Date.parse(m.cuando) : NaN;
	const reloj = Number.isFinite(suHora)
		? Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.round((suHora - ahora.getTime()) / 1000)))
		: null;
	return {
		cuando: ahora,
		cpu: numero(m.cpu, 100),
		carga1: numero(m.carga1, 1e6),
		cpus: cpus === null ? null : Math.floor(cpus),
		memoriaTotal: mem?.total ?? null,
		memoriaLibre: mem?.libre ?? null,
		discoTotal: disco?.total ?? null,
		discoLibre: disco?.libre ?? null,
		trampas,
		colaPendiente: pendiente === null ? null : Math.round(pendiente),
		colaSinEntregar: sinEntregar === null ? null : Math.round(sinEntregar),
		colaDescartando: cola ? cola.descartando === true : null,
		reloj
	};
}

const ultimaGuardada = new Map<string, number>();

/* Guarda la muestra de un sensor, salvo que llegue antes de tiempo. */
export async function guardarMuestra(sensor: string, m: Muestra): Promise<boolean> {
	const antes = ultimaGuardada.get(sensor);
	if (antes !== undefined && m.cuando.getTime() - antes < ENTRE_MUESTRAS) return false;
	ultimaGuardada.set(sensor, m.cuando.getTime());
	await db.insert(s.saludMuestras).values({ sensor, ...m });
	return true;
}

/* Lo que pasa de 7 días, cada hora con la conservación. */
export async function podarSalud(ahora = Date.now()) {
	await db
		.delete(s.saludMuestras)
		.where(lt(s.saludMuestras.cuando, new Date(ahora - DIAS_SALUD * 86_400_000)));
}

/* Lo usado de una capacidad, de 0 a 1, o null si no se sabe. */
export function usado(total: number | null, libre: number | null): number | null {
	if (!total || libre === null) return null;
	return Math.min(1, Math.max(0, 1 - libre / total));
}

export type ProblemaMaquina = {
	clave: string;
	codigo:
		| 'salud.disco-casi-lleno'
		| 'salud.disco-lleno'
		| 'salud.memoria'
		| 'salud.cpu'
		| 'salud.trampa-reinicios'
		| 'salud.trampa-callada'
		| 'salud.cola-atascada'
		| 'salud.cola-descartando'
		| 'salud.reloj';
	sobre: { tipo: 'sensor' | 'trampa'; id: string; nombre: string };
	severidad: 'baja' | 'media' | 'alta';
	titulo: string;
	texto: string;
};

const pct = (f: number) => `${Math.round(f * 100)} %`;
const bytesTexto = (n: number) =>
	n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/*
 * Los problemas de máquina y de reinicios, puros: de las muestras recientes de
 * cada sensor (las de la última media hora, de más nueva a más vieja).
 */
export function problemasDeMuestras(
	sensores: { id: string; nombre: string; muestras: Muestra[] }[],
	nombresTrampa: Map<string, string>,
	ahora: number
): ProblemaMaquina[] {
	const r: ProblemaMaquina[] = [];
	for (const x of sensores) {
		const ms = x.muestras;
		const ultima = ms[0];
		if (!ultima || ahora - ultima.cuando.getTime() > VIGENTE) continue;
		const sobre = { tipo: 'sensor' as const, id: x.id, nombre: x.nombre };
		const d = usado(ultima.discoTotal, ultima.discoLibre);
		if (d !== null && d >= DISCO_CASI) {
			const lleno = d >= DISCO_LLENO;
			r.push({
				clave: `disco:${x.id}`,
				codigo: lleno ? 'salud.disco-lleno' : 'salud.disco-casi-lleno',
				sobre,
				severidad: lleno ? 'alta' : 'media',
				titulo: lleno
					? `The disk of sensor "${x.nombre}" is full (${pct(d)})`
					: `The disk of sensor "${x.nombre}" is almost full (${pct(d)})`,
				texto: lleno
					? 'Honeypots may stop writing and events may be lost. Free up space or enlarge the disk of its machine.'
					: 'Free up space or enlarge the disk of its machine before honeypots stop writing.'
			});
		}
		const enVentana = (minutos: number) =>
			ms.filter((m) => ahora - m.cuando.getTime() <= minutos * MINUTO + 30_000);
		const memoria = enVentana(MINUTOS_MEMORIA);
		if (
			memoria.length >= MINUTOS_MEMORIA - 1 &&
			memoria.every((m) => {
				const u = usado(m.memoriaTotal, m.memoriaLibre);
				return u !== null && 1 - u < MEMORIA_MINIMA;
			})
		)
			r.push({
				clave: `memoria:${x.id}`,
				codigo: 'salud.memoria',
				sobre,
				severidad: 'media',
				titulo: `Sensor "${x.nombre}" is running out of memory`,
				texto: `Less than ${pct(MEMORIA_MINIMA)} of its memory has been available for ${MINUTOS_MEMORIA} minutes. Honeypots may be killed by the system. Add memory to its machine or move some honeypots to another sensor.`
			});
		const cpu = enVentana(MINUTOS_CPU);
		if (cpu.length >= MINUTOS_CPU - 2 && cpu.every((m) => m.cpu !== null && m.cpu >= CPU_ALTA))
			r.push({
				clave: `cpu:${x.id}`,
				codigo: 'salud.cpu',
				sobre,
				severidad: 'baja',
				titulo: `Sensor "${x.nombre}" has been at full CPU for ${MINUTOS_CPU} minutes`,
				texto: `Its processor has stayed above ${CPU_ALTA} %. Honeypots may answer slowly, which an attacker can notice. Check what else runs on its machine or give it more processors.`
			});
		/* La tubería: lo que la trampa ve y no llega a la consola. */
		if ((ultima.colaSinEntregar ?? 0) >= MINUTOS_COLA * 60)
			r.push({
				clave: `cola:${x.id}`,
				codigo: 'salud.cola-atascada',
				sobre,
				severidad: 'alta',
				titulo: `Events from sensor "${x.nombre}" are not reaching the console`,
				texto: `Its outgoing queue has not been fully delivered for ${Math.round((ultima.colaSinEntregar ?? 0) / 60)} minutes (${bytesTexto(ultima.colaPendiente ?? 0)} waiting). Its honeypots detect, but you do not see it here yet. Check the network between the sensor and this console.`
			});
		if (ultima.colaDescartando)
			r.push({
				clave: `descarte:${x.id}`,
				codigo: 'salud.cola-descartando',
				sobre,
				severidad: 'alta',
				titulo: `Sensor "${x.nombre}" is discarding events`,
				texto:
					'Its outgoing queue is full: new events are counted in a summary but their detail is lost. Free up disk on its machine or check why the console does not collect them.'
			});
		const relojes = ms.slice(0, MUESTRAS_RELOJ);
		if (
			relojes.length === MUESTRAS_RELOJ &&
			relojes.every((m) => m.reloj != null && Math.abs(m.reloj) > RELOJ_MAXIMO)
		) {
			const d = ultima.reloj ?? 0;
			r.push({
				clave: `reloj:${x.id}`,
				codigo: 'salud.reloj',
				sobre,
				severidad: 'media',
				titulo: `The clock of sensor "${x.nombre}" is ${Math.round(Math.abs(d) / 60)} minutes ${d > 0 ? 'ahead' : 'behind'}`,
				texto:
					'The times of its events are wrong, which breaks timelines and correlation in your SIEM. Turn on time synchronisation (NTP) on its machine.'
			});
		}
		/* Reinicios: la muestra más vieja de la media hora frente a la de ahora. */
		const vieja = enVentana(MINUTOS_REINICIOS).at(-1);
		if (vieja && vieja !== ultima) {
			const antes = new Map(vieja.trampas.map((t) => [t.id, t.reinicios]));
			for (const t of ultima.trampas) {
				const a = antes.get(t.id);
				if (a === undefined || t.reinicios - a < REINICIOS_BUCLE) continue;
				const nombre = nombresTrampa.get(t.id);
				if (!nombre) continue;
				r.push({
					clave: `reinicios:${t.id}`,
					codigo: 'salud.trampa-reinicios',
					sobre: { tipo: 'trampa', id: t.id, nombre },
					severidad: 'alta',
					titulo: `Honeypot "${nombre}" keeps restarting`,
					texto: `It has restarted ${t.reinicios - a} times in the last ${MINUTOS_REINICIOS} minutes: it fails as it starts and does not detect anything reliably. Look at its logs on the sensor or reinstall it.`
				});
			}
		}
	}
	return r;
}

/* Las muestras de la última media hora de cada sensor sin retirar. */
async function muestrasRecientes(ahora: number) {
	const sensores = await db
		.select({ id: s.sensores.id, nombre: s.sensores.nombre })
		.from(s.sensores)
		.where(isNull(s.sensores.retirado));
	if (!sensores.length) return [];
	const filas = await db
		.select()
		.from(s.saludMuestras)
		.where(
			and(
				inArray(
					s.saludMuestras.sensor,
					sensores.map((x) => x.id)
				),
				gte(s.saludMuestras.cuando, new Date(ahora - (MINUTOS_REINICIOS + 1) * MINUTO))
			)
		)
		.orderBy(desc(s.saludMuestras.cuando));
	const por = new Map<string, Muestra[]>();
	for (const f of filas) {
		const l = por.get(f.sensor) ?? [];
		l.push(f);
		por.set(f.sensor, l);
	}
	return sensores.map((x) => ({ ...x, muestras: por.get(x.id) ?? [] }));
}

/*
 * Las trampas que se han callado, calculado como mucho una vez por hora: mira
 * 9 días de eventos y una trampa callada no corre prisa.
 */
let calladas: { cuando: number; lista: ProblemaMaquina[] } | null = null;

export function trampasCalladas(
	cuentas: { trampa: string; recientes: number; antes: number; dias: number }[],
	trampas: { id: string; nombre: string; creado: Date }[],
	ahora: number
): ProblemaMaquina[] {
	const por = new Map(cuentas.map((c) => [c.trampa, c]));
	const r: ProblemaMaquina[] = [];
	for (const t of trampas) {
		/* Una recién puesta no tiene semana anterior con la que comparar. */
		if (ahora - t.creado.getTime() < (HORAS_CALLADA + 7 * 24) * 60 * MINUTO) continue;
		const c = por.get(t.id);
		if (!c || c.recientes > 0 || c.antes < EVENTOS_ANTES_CALLADA || c.dias < DIAS_ANTES_CALLADA)
			continue;
		r.push({
			clave: `callada:${t.id}`,
			codigo: 'salud.trampa-callada',
			sobre: { tipo: 'trampa', id: t.id, nombre: t.nombre },
			severidad: 'media',
			titulo: `Honeypot "${t.nombre}" has gone quiet`,
			texto: `It received ${c.antes} events in the week before and none in the last ${HORAS_CALLADA} hours. It may no longer be reachable: check firewall rules, DNS records and port forwarding that point to it.`
		});
	}
	return r;
}

async function calcularCalladas(ahora: number): Promise<ProblemaMaquina[]> {
	/* En texto: dentro de sql`` el driver no convierte un Date. */
	const corte = new Date(ahora - HORAS_CALLADA * 60 * MINUTO).toISOString();
	const cuentas = await db
		.select({
			trampa: s.eventos.trampa,
			recientes:
				sql<number>`count(*) filter (where ${s.eventos.recibido} >= ${corte}::timestamptz)`.mapWith(
					Number
				),
			antes:
				sql<number>`count(*) filter (where ${s.eventos.recibido} < ${corte}::timestamptz)`.mapWith(
					Number
				),
			/* En cuántos días (UTC) de la semana anterior recibió algo: una ráfaga no es tráfico. */
			dias: sql<number>`count(distinct date_trunc('day', ${s.eventos.recibido} at time zone 'UTC')) filter (where ${s.eventos.recibido} < ${corte}::timestamptz)`.mapWith(
				Number
			)
		})
		.from(s.eventos)
		.where(
			and(
				gte(s.eventos.recibido, new Date(ahora - (HORAS_CALLADA + 7 * 24) * 60 * MINUTO)),
				eq(s.eventos.prueba, false)
			)
		)
		.groupBy(s.eventos.trampa);
	if (!cuentas.length) return [];
	const trampas = await db
		.select({ id: s.trampas.id, nombre: s.trampas.nombre, creado: s.trampas.creado })
		.from(s.trampas)
		.where(
			and(
				eq(s.trampas.activo, true),
				inArray(
					s.trampas.id,
					cuentas.map((c) => c.trampa)
				)
			)
		);
	return trampasCalladas(cuentas, trampas, ahora);
}

/* Todos los problemas de salud de máquina y trampas de ahora, para salidas/salud.ts. */
export async function problemasMaquinaDeAhora(ahora = Date.now()): Promise<ProblemaMaquina[]> {
	const sensores = await muestrasRecientes(ahora);
	const ids = new Set(sensores.flatMap((x) => x.muestras[0]?.trampas.map((t) => t.id) ?? []));
	const nombres = new Map<string, string>();
	if (ids.size)
		for (const t of await db
			.select({ id: s.trampas.id, nombre: s.trampas.nombre })
			.from(s.trampas)
			.where(inArray(s.trampas.id, [...ids])))
			nombres.set(t.id, t.nombre);
	const r = problemasDeMuestras(sensores, nombres, ahora);
	/* Si no se pueden contar, lo de la máquina avisa igual; se reintenta en la siguiente vuelta. */
	if (!calladas || ahora - calladas.cuando > 60 * MINUTO)
		try {
			calladas = { cuando: ahora, lista: await calcularCalladas(ahora) };
		} catch (e) {
			console.error('[salud] quiet honeypots:', e instanceof Error ? e.message : e);
		}
	return [...r, ...(calladas?.lista ?? [])];
}

/* Para las pruebas: que la siguiente vuelta vuelva a contar las calladas. */
export function olvidarCalladas() {
	calladas = null;
	ultimaGuardada.clear();
}

export type PuntoSerie = {
	cuando: string;
	cpu: number | null;
	memoria: number | null;
	disco: number | null;
	carga1: number | null;
};

/*
 * La serie de un sensor para la pestaña «Health»: 24 horas, minuto a minuto; 7
 * días, de media cada cuarto de hora. memoria y disco: lo usado, de 0 a 1.
 */
export async function serieDe(
	sensor: string,
	rango: '24h' | '7d',
	ahora = Date.now()
): Promise<PuntoSerie[]> {
	const desde = new Date(ahora - (rango === '24h' ? 1 : 7) * 86_400_000);
	/* Constante (60 o 900), en el texto: con parámetros, el GROUP BY no casa con el SELECT. */
	const paso = sql.raw(rango === '24h' ? '60' : '900');
	const cubo = sql`to_timestamp(floor(extract(epoch from ${s.saludMuestras.cuando}) / ${paso}) * ${paso})`;
	const filas = await db
		.select({
			cuando: sql<string>`to_char(${cubo} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
			cpu: sql<number | null>`avg(${s.saludMuestras.cpu})`.mapWith((v) =>
				v === null ? null : Number(v)
			),
			carga1: sql<number | null>`avg(${s.saludMuestras.carga1})`.mapWith((v) =>
				v === null ? null : Number(v)
			),
			memoria: sql<
				number | null
			>`avg(1 - ${s.saludMuestras.memoriaLibre}::float8 / nullif(${s.saludMuestras.memoriaTotal}, 0))`.mapWith(
				(v) => (v === null ? null : Number(v))
			),
			disco: sql<
				number | null
			>`avg(1 - ${s.saludMuestras.discoLibre}::float8 / nullif(${s.saludMuestras.discoTotal}, 0))`.mapWith(
				(v) => (v === null ? null : Number(v))
			)
		})
		.from(s.saludMuestras)
		.where(and(eq(s.saludMuestras.sensor, sensor), gte(s.saludMuestras.cuando, desde)))
		.groupBy(cubo)
		.orderBy(cubo);
	return filas;
}

/* La última muestra de cada sensor, para la cabecera de la pestaña y el latido. */
export async function ultimasMuestras(): Promise<Map<string, Muestra>> {
	const filas = await db
		.selectDistinctOn([s.saludMuestras.sensor])
		.from(s.saludMuestras)
		.where(gte(s.saludMuestras.cuando, new Date(Date.now() - VIGENTE)))
		.orderBy(s.saludMuestras.sensor, desc(s.saludMuestras.cuando));
	return new Map(filas.map((f) => [f.sensor, f]));
}

/* Las claves de avisos_salud que vienen de aquí (salidas/salud.ts). */
const CLAVES_MAQUINA = [
	'disco',
	'memoria',
	'cpu',
	'cola',
	'descarte',
	'reloj',
	'reinicios',
	'callada'
];

/*
 * Lo que el latido lleva al panel (docs/diseno/salud.md): lo peor de las máquinas
 * de los sensores con muestra reciente y cuántas trampas no corren y avisos
 * abiertos. Solo números. Sin muestras recientes no va nada.
 */
export async function saludParaLatido(): Promise<{ salud?: LatidoSalud }> {
	const ultimas = [...(await ultimasMuestras()).values()];
	if (!ultimas.length) return {};
	const peor = (f: (m: Muestra) => number | null) => {
		const v = ultimas.map(f).filter((x): x is number => x !== null);
		return v.length ? Math.round(Math.max(...v) * 1000) / 1000 : null;
	};
	const abiertos = await db.select({ clave: s.avisosSalud.clave }).from(s.avisosSalud);
	return {
		salud: {
			sensores: ultimas.length,
			disco: peor((m) => usado(m.discoTotal, m.discoLibre)),
			memoria: peor((m) => usado(m.memoriaTotal, m.memoriaLibre)),
			cpu: peor((m) => (m.cpu === null ? null : m.cpu / 100)),
			trampasParadas: ultimas.reduce((n, m) => n + m.trampas.filter((t) => !t.enMarcha).length, 0),
			avisos: abiertos.filter((a) => CLAVES_MAQUINA.includes(a.clave.split(':')[0])).length
		}
	};
}
