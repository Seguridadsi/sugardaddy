/*
 * Ventanas de mantenimiento: una parada programada (parches, reinicios) de
 * todo el nodo, de unos sitios o de unos sensores. Mientras dura:
 *
 * - los eventos se siguen guardando y avisando como siempre: una trampa tocada
 *   en pleno mantenimiento es justo lo que más interesa;
 * - los avisos de SALUD de su alcance no salen: sensor sin latido, silencio
 *   (salud.silencio), trampa caída o parada (salidas/salud.ts los aparta con
 *   coberturaDeAhora y apunta aquí lo que calló).
 *
 * Tiene tope de duración (MAXIMO_HORAS_DEFECTO, que el administrador puede
 * bajar o subir hasta TOPE_HORAS), termina sola y deja un resumen: qué se calló,
 * qué eventos hubo y qué sensores seguían parados al acabar (esos avisan ya).
 * Se avisa al empezar y al terminar (mantenimiento-avisos.ts), y quién la abre
 * o la cierra queda en la auditoría.
 *
 * Pieza gratis: en Community no hay avisos, pero la ventana, su resumen y lo que
 * dice el latido al panel (mantenimientoParaLatido) funcionan igual. El reloj de
 * hooks.server.ts llama a vigilarMantenimiento cada minuto.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { formatearFecha, nombreZona } from '../fechas';
import { db, schema as s } from './db';
import type { ResumenMantenimiento } from './db/schema';
import { avisarMantenimiento } from './mantenimiento-avisos';
import { zonaDocumentos } from './zona-documentos';

/*
 * Como consultas.auditar y consultas.nombresTrampas, sin importar consultas.ts:
 * salidas/salud.ts nos importa y sus pruebas simulan la base (como copias-fuera.ts).
 */
const auditar = async (quien: string, accion: string, detalle: Record<string, unknown> = {}) => {
	await db.insert(s.auditoria).values({ quien, accion, detalle });
};
const nombresTrampas = async (): Promise<Record<string, string>> =>
	Object.fromEntries(
		(await db.select({ id: s.trampas.id, nombre: s.trampas.nombre }).from(s.trampas)).map((f) => [
			f.id,
			f.nombre
		])
	);

export type VentanaMantenimiento = typeof s.ventanasMantenimiento.$inferSelect;
export type AlcanceMantenimiento = VentanaMantenimiento['alcance'];

/* Lo que puede durar una ventana como mucho, por mucho que lo suba el administrador. */
export const TOPE_HORAS = 72;
/* Lo que puede durar si el administrador no dice otra cosa. */
export const MAXIMO_HORAS_DEFECTO = 24;
/* Lo que se ofrece en el formulario (recortado al máximo del nodo). */
export const DURACIONES = [1, 2, 4, 8, 12, 24, 48, 72] as const;
export const MAX_OBJETIVOS = 100;
/* El mismo plazo que en Sensores y en salidas/salud.ts. */
const LATIDO_MAXIMO = 5 * 60_000;

const AJUSTE = 'mantenimiento';

/* ---------- el ajuste del administrador ---------- */

export async function maximoHoras(): Promise<number> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE));
	const h = Number((f?.valor as { maximoHoras?: unknown } | undefined)?.maximoHoras);
	return Number.isInteger(h) && h >= 1 && h <= TOPE_HORAS ? h : MAXIMO_HORAS_DEFECTO;
}

export async function fijarMaximoHoras(quien: string, horas: number): Promise<boolean> {
	if (!Number.isInteger(horas) || horas < 1 || horas > TOPE_HORAS) return false;
	const antes = await maximoHoras();
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE, valor: { maximoHoras: horas } })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: { maximoHoras: horas } } });
	await auditar(quien, 'maintenance window limit changed', { antes, ahora: horas });
	return true;
}

/* ---------- qué cubre ---------- */

export type Cobertura = {
	/* Alguna ventana en curso es de todo el nodo. */
	nodo: boolean;
	/* Por sensor y por trampa, qué ventanas en curso los cubren. */
	sensores: Map<string, string[]>;
	trampas: Map<string, string[]>;
	ventanas: VentanaMantenimiento[];
};

type Destino = { id: string; sensor: string | null };
type Trampa = { id: string; sensor: string; destino: string | null };

/*
 * Lo que cubre cada ventana. Un sitio cubre su sensor (si es una máquina con
 * sensor) y las trampas puestas en él: las que tienen ese destino y las que, sin
 * destino, están en la máquina de su sensor. Unos sensores cubren también sus
 * trampas. Pura: se prueba sin base.
 */
export function cobertura(
	ventanas: VentanaMantenimiento[],
	destinos: Destino[],
	trampas: Trampa[],
	sensores: string[]
): Cobertura {
	const c: Cobertura = { nodo: false, sensores: new Map(), trampas: new Map(), ventanas };
	const poner = (m: Map<string, string[]>, id: string, v: string) =>
		m.set(id, [...(m.get(id) ?? []), v]);
	for (const v of ventanas) {
		let ss: Set<string>;
		let ts: Set<string>;
		if (v.alcance === 'nodo') {
			c.nodo = true;
			ss = new Set(sensores);
			ts = new Set(trampas.map((t) => t.id));
		} else if (v.alcance === 'sensores') {
			ss = new Set(v.objetivos);
			ts = new Set(trampas.filter((t) => ss.has(t.sensor)).map((t) => t.id));
		} else {
			const sitios = new Set(v.objetivos);
			ss = new Set(
				destinos.filter((d) => sitios.has(d.id) && d.sensor).map((d) => d.sensor as string)
			);
			ts = new Set(
				trampas
					.filter((t) => (t.destino ? sitios.has(t.destino) : ss.has(t.sensor)))
					.map((t) => t.id)
			);
		}
		for (const x of ss) poner(c.sensores, x, v.id);
		for (const x of ts) poner(c.trampas, x, v.id);
	}
	return c;
}

/* Las que están en curso ahora: han empezado y no han terminado. */
export const ventanasEnCurso = (ahora = new Date()) =>
	db
		.select()
		.from(s.ventanasMantenimiento)
		.where(and(lte(s.ventanasMantenimiento.desde, ahora), gt(s.ventanasMantenimiento.hasta, ahora)))
		.orderBy(asc(s.ventanasMantenimiento.hasta));

async function coberturaDe(ventanas: VentanaMantenimiento[]): Promise<Cobertura> {
	if (!ventanas.length) return cobertura([], [], [], []);
	const [destinos, trampas, sensores] = await Promise.all([
		db.select({ id: s.destinos.id, sensor: s.destinos.sensor }).from(s.destinos),
		db
			.select({ id: s.trampas.id, sensor: s.trampas.sensor, destino: s.trampas.destino })
			.from(s.trampas),
		db.select({ id: s.sensores.id }).from(s.sensores)
	]);
	return cobertura(
		ventanas,
		destinos,
		trampas,
		sensores.map((x) => x.id)
	);
}

/* Lo que está en mantenimiento ahora mismo (salidas/salud.ts, Sensores, el latido). */
export async function coberturaDeAhora(ahora = Date.now()): Promise<Cobertura> {
	return coberturaDe(await ventanasEnCurso(new Date(ahora)));
}

/*
 * Apunta en cada ventana los avisos de salud que se han callado por ella. Una
 * vez por clave y ventana: si ya estaba, se queda el primero (desde cuándo).
 */
export async function registrarCallados(
	lista: { clave: string; codigo: string; nombre: string; ventanas: string[] }[],
	ahora = Date.now()
) {
	const porVentana = new Map<
		string,
		Record<string, { codigo: string; nombre: string; desde: string }>
	>();
	for (const x of lista)
		for (const v of x.ventanas)
			porVentana.set(v, {
				...(porVentana.get(v) ?? {}),
				[x.clave]: { codigo: x.codigo, nombre: x.nombre, desde: new Date(ahora).toISOString() }
			});
	for (const [id, nuevos] of porVentana)
		await db
			.update(s.ventanasMantenimiento)
			/* Lo que ya estaba gana: jsonb || deja el de la derecha. */
			.set({ callado: sql`${JSON.stringify(nuevos)}::jsonb || ${s.ventanasMantenimiento.callado}` })
			.where(eq(s.ventanasMantenimiento.id, id));
}

/* ---------- abrir y cerrar ---------- */

export const ventanasTodas = () =>
	db.select().from(s.ventanasMantenimiento).orderBy(desc(s.ventanasMantenimiento.desde)).limit(50);

export const ventanaMantenimiento = async (id: string) =>
	(await db.select().from(s.ventanasMantenimiento).where(eq(s.ventanasMantenimiento.id, id)))[0] ??
	null;

export type DatosMantenimiento = {
	nombre: string;
	alcance: AlcanceMantenimiento;
	objetivos: string[];
	desde: Date;
	hasta: Date;
	nota: string | null;
};

export async function crearMantenimiento(
	quien: string,
	d: DatosMantenimiento,
	ahora = new Date()
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const nombre = d.nombre.trim().slice(0, 80);
	if (!nombre) return { ok: false, error: 'Name: enter one (e.g. "Monthly patching").' };
	if (!['nodo', 'sitios', 'sensores'].includes(d.alcance))
		return { ok: false, error: 'Choose what it covers.' };
	const objetivos = d.alcance === 'nodo' ? [] : [...new Set(d.objetivos)];
	if (d.alcance !== 'nodo' && !objetivos.length)
		return {
			ok: false,
			error: d.alcance === 'sitios' ? 'Choose at least one site.' : 'Choose at least one sensor.'
		};
	if (objetivos.length > MAX_OBJETIVOS)
		return { ok: false, error: `At most ${MAX_OBJETIVOS} at a time.` };
	/* Solo lo que existe: un id inventado no cubriría nada y daría una ventana engañosa. */
	if (objetivos.length) {
		const t = d.alcance === 'sitios' ? s.destinos : s.sensores;
		const hay = await db.select({ id: t.id }).from(t).where(inArray(t.id, objetivos));
		if (hay.length !== objetivos.length)
			return { ok: false, error: 'Some of the chosen items no longer exist. Reload the page.' };
	}
	if (!(d.hasta > d.desde)) return { ok: false, error: 'The end must be after the start.' };
	if (d.hasta <= ahora) return { ok: false, error: 'That window would already be over.' };
	/* Programada con antelación: como mucho a 90 días vista. */
	if (d.desde.getTime() - ahora.getTime() > 90 * 86_400_000)
		return { ok: false, error: 'It must start within the next 90 days.' };
	const maximo = await maximoHoras();
	if (d.hasta.getTime() - d.desde.getTime() > maximo * 3_600_000)
		return { ok: false, error: `At most ${maximo} hours (Settings tab).` };
	const [f] = await db
		.insert(s.ventanasMantenimiento)
		.values({
			nombre,
			alcance: d.alcance,
			objetivos,
			desde: d.desde,
			hasta: d.hasta,
			nota: d.nota?.trim().slice(0, 500) || null,
			quien
		})
		.returning({ id: s.ventanasMantenimiento.id });
	await auditar(quien, 'maintenance window scheduled', {
		id: f.id,
		nombre,
		alcance: d.alcance,
		objetivos,
		desde: d.desde.toISOString(),
		hasta: d.hasta.toISOString()
	});
	await vigilarMantenimiento(ahora);
	return { ok: true, id: f.id };
}

/* «End now»: termina ya y hace su resumen (o se anula, si no había empezado). */
export async function terminarMantenimiento(
	quien: string,
	id: string,
	ahora = new Date()
): Promise<'terminada' | 'anulada' | null> {
	const [f] = await db
		.update(s.ventanasMantenimiento)
		.set({ hasta: ahora, cerradaPor: quien })
		.where(and(eq(s.ventanasMantenimiento.id, id), gt(s.ventanasMantenimiento.hasta, ahora)))
		.returning();
	if (!f) return null;
	if (f.desde >= ahora) {
		await db.delete(s.ventanasMantenimiento).where(eq(s.ventanasMantenimiento.id, id));
		await auditar(quien, 'maintenance window cancelled', { id, nombre: f.nombre });
		return 'anulada';
	}
	await auditar(quien, 'maintenance window ended manually', { id, nombre: f.nombre });
	await vigilarMantenimiento(ahora);
	return 'terminada';
}

/* ---------- el resumen ---------- */

export async function resumenMantenimiento(
	v: VentanaMantenimiento,
	ahora = Date.now()
): Promise<ResumenMantenimiento> {
	const c = await coberturaDe([v]);
	const trampas = [...c.trampas.keys()];
	const deAlcance = c.nodo
		? sql`true`
		: trampas.length
			? sql`trampa in (select jsonb_array_elements_text(${JSON.stringify(trampas)}::text::jsonb))`
			: sql`false`;
	const donde = sql`cuando >= ${v.desde.toISOString()}::timestamptz and cuando < ${v.hasta.toISOString()}::timestamptz and prueba = false and escaner is null and ${deAlcance}`;
	const contar = async (campo: 'trampa' | 'severidad') =>
		(await db.execute(
			sql`select ${sql.identifier(campo)} as clave, count(*)::int as n from eventos where ${donde} group by 1 order by 2 desc`
		)) as unknown as { clave: string; n: number }[];
	const porSeveridad = await contar('severidad');
	const nombres = await nombresTrampas();
	const sensoresCubiertos = [...c.sensores.keys()];
	const parados = sensoresCubiertos.length
		? await db
				.select({
					id: s.sensores.id,
					nombre: s.sensores.nombre,
					ultimoLatido: s.sensores.ultimoLatido
				})
				.from(s.sensores)
				.where(and(inArray(s.sensores.id, sensoresCubiertos), isNull(s.sensores.retirado)))
		: [];
	return {
		eventos: porSeveridad.reduce((t, x) => t + x.n, 0),
		porSeveridad: Object.fromEntries(porSeveridad.map((x) => [x.clave, x.n])),
		porTrampa: (await contar('trampa')).slice(0, 50).map((x) => ({
			trampa: x.clave,
			nombre: nombres[x.clave] ?? x.clave,
			eventos: x.n
		})),
		callados: Object.entries(v.callado)
			.map(([clave, x]) => ({ clave, ...x }))
			.sort((a, b) => a.desde.localeCompare(b.desde))
			.slice(0, 200),
		/* Uno que no ha latido nunca (sin instalar) no se cuenta: tampoco avisaría. */
		sinVolver: parados
			.filter((x) => x.ultimoLatido && ahora - x.ultimoLatido.getTime() >= LATIDO_MAXIMO)
			.map((x) => ({ id: x.id, nombre: x.nombre }))
	};
}

const cuenta = (n: number, uno: string, varios: string) =>
	`${n.toLocaleString('en-GB')} ${n === 1 ? uno : varios}`;

/* Qué cubre, en una frase («the whole node», «2 sites», «sensor "Sede"»). */
export function textoAlcance(
	v: Pick<VentanaMantenimiento, 'alcance' | 'objetivos'>,
	nombres: Record<string, string> = {}
): string {
	if (v.alcance === 'nodo') return 'the whole node';
	const uno = v.alcance === 'sitios' ? 'site' : 'sensor';
	if (v.objetivos.length === 1) return `${uno} "${nombres[v.objetivos[0]] ?? v.objetivos[0]}"`;
	return cuenta(v.objetivos.length, uno, `${uno}s`);
}

export function textoResumen(
	v: Pick<VentanaMantenimiento, 'alcance' | 'objetivos'>,
	r: ResumenMantenimiento,
	nombres: Record<string, string> = {}
) {
	const criticos = (r.porSeveridad.critica ?? 0) + (r.porSeveridad.alta ?? 0);
	const partes = [
		`${textoAlcance(v, nombres)}: ${cuenta(r.eventos, 'event', 'events')} during the window${criticos ? ` (${criticos} high or critical, which alerted as usual)` : ''}`,
		r.callados.length
			? `${cuenta(r.callados.length, 'health alert was', 'health alerts were')} held back`
			: 'no health alert was held back'
	];
	if (r.sinVolver.length)
		partes.push(
			`still not responding: ${r.sinVolver
				.slice(0, 5)
				.map((x) => `"${x.nombre}"`)
				.join(
					', '
				)}${r.sinVolver.length > 5 ? ` and ${r.sinVolver.length - 5} more` : ''} (health alerts resume now)`
		);
	return `${partes.join('; ')}. The full summary is in the console.`;
}

/* Los nombres de lo que cubre (sitios o sensores), para los textos. */
export async function nombresObjetivos(
	v: Pick<VentanaMantenimiento, 'alcance' | 'objetivos'>[]
): Promise<Record<string, string>> {
	const sitios = [...new Set(v.filter((x) => x.alcance === 'sitios').flatMap((x) => x.objetivos))];
	const sensores = [
		...new Set(v.filter((x) => x.alcance === 'sensores').flatMap((x) => x.objetivos))
	];
	const filas = [
		...(sitios.length
			? await db
					.select({ id: s.destinos.id, nombre: s.destinos.nombre })
					.from(s.destinos)
					.where(inArray(s.destinos.id, sitios))
			: []),
		...(sensores.length
			? await db
					.select({ id: s.sensores.id, nombre: s.sensores.nombre })
					.from(s.sensores)
					.where(inArray(s.sensores.id, sensores))
			: [])
	];
	return Object.fromEntries(filas.map((f) => [f.id, f.nombre]));
}

/* ---------- el reloj ---------- */

const fecha = (d: Date, zona: string) =>
	`${formatearFecha(d, 'semanaHoraLarga', zona)} (${nombreZona(zona)})`;

/*
 * Cada minuto: avisa de las ventanas que empiezan y hace el resumen de las que
 * han terminado. Cada cosa una sola vez (avisadoInicio, terminado).
 */
export async function vigilarMantenimiento(ahora = new Date()) {
	const empiezan = await db
		.select()
		.from(s.ventanasMantenimiento)
		.where(
			and(
				isNull(s.ventanasMantenimiento.avisadoInicio),
				lte(s.ventanasMantenimiento.desde, ahora),
				gt(s.ventanasMantenimiento.hasta, ahora)
			)
		)
		.orderBy(asc(s.ventanasMantenimiento.desde));
	const terminan = await db
		.select()
		.from(s.ventanasMantenimiento)
		.where(
			and(isNull(s.ventanasMantenimiento.terminado), lte(s.ventanasMantenimiento.hasta, ahora))
		);
	if (!empiezan.length && !terminan.length) return;
	const zona = await zonaDocumentos();
	const nombres = await nombresObjetivos([...empiezan, ...terminan]);
	for (const v of empiezan) {
		/* Solo quien la marca primero avisa: dos relojes a la vez no avisan dos veces. */
		const [marcada] = await db
			.update(s.ventanasMantenimiento)
			.set({ avisadoInicio: ahora })
			.where(
				and(eq(s.ventanasMantenimiento.id, v.id), isNull(s.ventanasMantenimiento.avisadoInicio))
			)
			.returning({ id: s.ventanasMantenimiento.id });
		if (!marcada) continue;
		avisarMantenimiento({
			codigo: 'mantenimiento.inicio',
			severidad: 'media',
			titulo: `Maintenance window "${v.nombre}" until ${fecha(v.hasta, zona)}`,
			texto: `Until then, health alerts for ${textoAlcance(v, nombres)} (sensor not responding, sensor silent, honeypot down or stopped) are held back. Events are still stored and attacks still alert. A summary will arrive when the window ends.`,
			sobre: { tipo: 'mantenimiento', id: v.id, nombre: v.nombre },
			datos: {
				alcance: v.alcance,
				objetivos: v.objetivos,
				desde: v.desde.toISOString(),
				hasta: v.hasta.toISOString(),
				quien: v.quien
			}
		});
	}
	for (const v of terminan) {
		const resumen = await resumenMantenimiento(v, ahora.getTime());
		const [marcada] = await db
			.update(s.ventanasMantenimiento)
			.set({ resumen, terminado: ahora })
			.where(and(eq(s.ventanasMantenimiento.id, v.id), isNull(s.ventanasMantenimiento.terminado)))
			.returning({ id: s.ventanasMantenimiento.id });
		if (!marcada) continue;
		/* Una anulada antes de empezar se borra en terminarMantenimiento: aquí no llega. */
		avisarMantenimiento({
			codigo: 'mantenimiento.resumen',
			severidad: resumen.sinVolver.length ? 'alta' : 'baja',
			titulo: `End of maintenance window "${v.nombre}": ${cuenta(resumen.eventos, 'event', 'events')}, ${cuenta(resumen.callados.length, 'health alert', 'health alerts')} held back`,
			texto: textoResumen(v, resumen, nombres),
			sobre: { tipo: 'mantenimiento', id: v.id, nombre: v.nombre },
			datos: {
				alcance: v.alcance,
				eventos: resumen.eventos,
				callados: resumen.callados.length,
				sinVolver: resumen.sinVolver.map((x) => x.id),
				cerradaPor: v.cerradaPor
			}
		});
	}
}

/* ---------- lo que ven otros ---------- */

/* La ventana en curso que antes termina, para el aviso de arriba de todas las pantallas. */
export async function mantenimientoActivo(ahora = new Date()) {
	const [v] = await ventanasEnCurso(ahora);
	if (!v) return null;
	const nombres = await nombresObjetivos([v]);
	return {
		id: v.id,
		nombre: v.nombre,
		hasta: v.hasta.toISOString(),
		alcance: textoAlcance(v, nombres)
	};
}

/*
 * Lo que va en el latido al panel (opcional en el contrato: un panel anterior lo
 * ignora). Si alguna ventana cubre todo el nodo, hasta cuándo: el panel no da
 * por caído un nodo que no late mientras tanto. Y cuántos sensores parados lo
 * están por mantenimiento, para no contarlos como caídos.
 */
export async function mantenimientoParaLatido(
	ahora = Date.now()
): Promise<{ mantenimiento?: { hasta: string; nodo: boolean; sensoresParados: number } }> {
	const c = await coberturaDeAhora(ahora);
	if (!c.ventanas.length) return {};
	const deNodo = c.ventanas.filter((v) => v.alcance === 'nodo');
	/* Hasta cuándo: la última de las de todo el nodo, o la última de todas si no hay. */
	const hasta = new Date(
		Math.max(...(deNodo.length ? deNodo : c.ventanas).map((v) => v.hasta.getTime()))
	).toISOString();
	const cubiertos = [...c.sensores.keys()];
	const parados = cubiertos.length
		? await db
				.select({ id: s.sensores.id, ultimoLatido: s.sensores.ultimoLatido })
				.from(s.sensores)
				.where(and(inArray(s.sensores.id, cubiertos), isNull(s.sensores.retirado)))
		: [];
	return {
		mantenimiento: {
			hasta,
			nodo: c.nodo,
			sensoresParados: parados.filter(
				(x) => !x.ultimoLatido || ahora - x.ultimoLatido.getTime() >= LATIDO_MAXIMO
			).length
		}
	};
}
