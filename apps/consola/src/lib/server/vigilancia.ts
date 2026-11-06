/*
 * Lo que el cliente decide enseñar a quien le vigila (docs/diseno/vista-soc.md): sus
 * incidentes, para que salgan en la vista del panel. Apagado por defecto. Solo el origen,
 * la gravedad, el motivo, las cuentas, el nombre de las trampas y si alguien lo atiende, sin
 * su nombre: nunca los eventos, ni lo que escribió el atacante, ni credenciales. Al apagarlo,
 * se borran del panel.
 *
 * Cada fila recuerda hasta qué cambio se subió, así que da igual que el panel no conteste o
 * que una transacción acabe tarde: lo que no llegó se vuelve a mandar.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { AtencionIncidente, IncidenteSubido } from '@sugardaddy/canal';
import { auditar, nombresTrampas } from './consultas';
import { db, schema as s } from './db';

const t = s.incidentesAbiertos;

/* Lo que cabe en una petición al panel (64 KiB), con 20 nombres de 60 caracteres por fila. */
export const POR_ENVIO = 30;
const MAX_TRAMPAS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Vigilancia = {
	incidentes: boolean;
	/* Desde cuándo: lo cerrado de antes no se sube, porque no se consintió. */
	desde: string | null;
	/* Se apagó y el panel aún no lo ha borrado. */
	borrar: boolean;
	/* Se cortó el canal sin poder decírselo al panel: se reintenta hasta que lo sepa. */
	corte: boolean;
};

const APAGADA: Vigilancia = { incidentes: false, desde: null, borrar: false, corte: false };

export async function vigilancia(): Promise<Vigilancia> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'vigilancia'));
	return { ...APAGADA, ...((f?.valor as Partial<Vigilancia> | undefined) ?? {}) };
}

async function guardar(v: Vigilancia) {
	await db
		.insert(s.ajustes)
		.values({ clave: 'vigilancia', valor: v })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: v } });
}

/* Que se vuelva a subir lo que toque: el panel ya no lo tiene. */
export async function volverASubir() {
	await db.update(t).set({ subido: null });
}

export async function compartirIncidentes(quien: string, si: boolean, ahora = new Date()) {
	const v = await vigilancia();
	if (v.incidentes === si) return v;
	const nueva: Vigilancia = si
		? { ...v, incidentes: true, desde: ahora.toISOString() }
		: { ...v, incidentes: false, desde: null, borrar: true };
	if (si) await volverASubir();
	await guardar(nueva);
	await auditar(quien, si ? 'Incidents shared with Central' : 'Incidents no longer shared');
	return nueva;
}

export async function borradoEnElPanel() {
	await guardar({ ...(await vigilancia()), borrar: false });
}

export async function corteSinAvisar(pendiente: boolean) {
	await guardar({ ...(await vigilancia()), corte: pendiente });
}

/* La dirección de la consola, para enlazarla desde el panel. Solo https, o local en pruebas. */
function consola() {
	const o = (env.ORIGIN ?? '').replace(/\/+$/, '');
	return /^https:\/\//.test(o) || /^http:\/\/localhost(:\d+)?$/.test(o) ? o : null;
}

/* Lo que sube en el latido: nada si el cliente no comparte ni tiene abierto el soporte. */
export async function paraLatido(soporteAbierto: boolean) {
	const { incidentes } = await vigilancia();
	return incidentes || soporteAbierto ? { vigilancia: { incidentes, consola: consola() } } : {};
}

const cambio = sql`greatest(${t.actividad}, ${t.cerrado}, ${t.atendido}, ${t.escalado})`;

/* Acotado sin dejar medio emoji: el panel no podría guardarlo y la fila se perdería. */
const acotar = (v: string, max: number) =>
	v
		.replace(/[\0\p{Cs}]/gu, '')
		.slice(0, max)
		.replace(/\p{Cs}/gu, '');

/*
 * Lo que el panel no tiene aún. La marca va como texto porque es lo que se compara después:
 * pasar por Date perdería los microsegundos y la fila se subiría siempre. Lo abierto y lo
 * grave, primero: con cola, un crítico nuevo no espera a que suba lo cerrado.
 */
export async function incidentesPorSubir(v: Vigilancia, limite = POR_ENVIO) {
	const desde = v.desde ?? new Date().toISOString();
	const filas = await db
		.select({ fila: t, marca: sql<string>`(${cambio})::text` })
		.from(t)
		.where(
			and(
				sql`(${t.subido} is null or ${t.subido} < ${cambio})`,
				or(eq(t.estado, 'abierto'), sql`${cambio} >= ${desde}::timestamptz`)
			)
		)
		.orderBy(
			sql`case ${t.estado} when 'abierto' then 0 else 1 end`,
			sql`case ${t.severidad} when 'critica' then 0 when 'alta' then 1 when 'media' then 2 else 3 end`,
			sql`${cambio} asc`
		)
		.limit(limite);
	if (!filas.length) return { incidentes: [], marcas: [] };
	const nombres = await nombresTrampas();
	const iso = (d: Date | null) => d?.toISOString() ?? null;
	const incidentes: IncidenteSubido[] = filas.map(({ fila: f }) => ({
		id: f.id,
		origen: f.origen,
		estado: f.estado,
		motivo: f.motivo,
		severidad: f.severidad,
		puntos: f.puntos,
		eventos: f.eventos,
		trampas: f.trampas
			.slice(0, MAX_TRAMPAS)
			.map((x) => acotar(nombres[x] ?? 'Removed decoy', 60) || 'Unnamed'),
		primero: f.primero.toISOString(),
		ultimo: f.ultimo.toISOString(),
		abierto: f.abierto.toISOString(),
		cerrado: iso(f.cerrado),
		atendido: iso(f.atendido),
		atendidoComo: f.atendidoComo,
		escalados: f.escalados
	}));
	return { incidentes, marcas: filas.map(({ fila, marca }) => ({ id: fila.id, marca })) };
}

export async function marcarIncidentesSubidos(marcas: { id: string; marca: string }[]) {
	for (const m of marcas)
		await db
			.update(t)
			.set({ subido: sql`${m.marca}::timestamptz` })
			.where(eq(t.id, m.id));
}

/*
 * Lo que alguien del panel ha dicho que atiende: ya no se escala, y el cliente ve quién.
 * Solo si comparte: quien no comparte no le ha dado esos incidentes al panel.
 */
export async function aplicarAtenciones(lista: AtencionIncidente[] | undefined) {
	if (!lista?.length || !(await vigilancia()).incidentes) return;
	for (const a of lista) {
		if (!UUID.test(a.id)) continue;
		const por = acotar(a.por, 120);
		const [f] = await db
			.update(t)
			.set({ atendido: new Date(), atendidoPor: por, atendidoComo: 'lo-miro' })
			.where(and(eq(t.id, a.id), isNull(t.atendido)))
			.returning({ origen: t.origen });
		if (f) await auditar(por, 'Incident handled from Central', { origen: f.origen });
	}
}
