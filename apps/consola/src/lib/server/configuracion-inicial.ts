/*
 * El estado de la configuración inicial (lib/configuracion-inicial.ts) en la base: una
 * sola clave de `ajustes`, y los hechos del nodo leídos de donde ya viven.
 */
import { eq, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import {
	MANUALES,
	OMITIBLES,
	SIN_EMPEZAR,
	pasos,
	pendientes,
	type Guardado,
	type Hechos,
	type IdPaso
} from '$lib/configuracion-inicial';
import { leerAcceso } from './acceso';
import { autoActualizar } from './consultas';
import { db, schema as s } from './db';
import { esCommunity } from './edicion';
import { estadoCodigoEmergencia } from './emergencia';
import { identidad } from './identidad';
import { estadoRegistro, puedeRegistrarse } from './registro';

const CLAVE = 'configuracion-inicial';

export async function leerConfiguracion(): Promise<Guardado> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	return { ...SIN_EMPEZAR, ...((f?.valor as Partial<Guardado> | undefined) ?? {}) };
}

async function escribir(valor: Guardado) {
	await db
		.insert(s.ajustes)
		.values({ clave: CLAVE, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

async function hayTrampas(): Promise<{ alguna: boolean; probada: boolean }> {
	const [f] = await db
		.select({
			total: sql<number>`count(*)::int`,
			probadas: sql<number>`count(*) filter (where ${s.trampas.colocacion} = 'comprobada')::int`
		})
		.from(s.trampas);
	return { alguna: f.total > 0, probada: f.probadas > 0 };
}

export async function hechos(usuario: { oid?: string | null }): Promise<Hechos> {
	const community = esCommunity();
	const [acceso, codigo, id, registrable, trampas, [{ salidas }]] = await Promise.all([
		leerAcceso(),
		estadoCodigoEmergencia(),
		identidad(),
		puedeRegistrarse(),
		hayTrampas(),
		db.select({ salidas: sql<number>`count(*)::int` }).from(s.salidas)
	]);
	return {
		community,
		cuentaLocal: !!usuario.oid?.startsWith('local:'),
		acceso: acceso.estado,
		hayCodigo: !!codigo,
		dominioDecidido: id.decidido,
		dominio: id.dominio,
		puedeRegistrarse: registrable,
		registrado: registrable && (await estadoRegistro()).estado === 'vigente',
		registroDecidido: registrable && (await autoActualizar()).decidido,
		hayAvisos: salidas > 0,
		raizPropia: env.TLS_MODO !== 'ficheros',
		hayTrampa: trampas.alguna,
		trampaProbada: trampas.probada
	};
}

/*
 * Lo que necesita el menú en cada página, con una sola lectura: si hay que enseñar el
 * enlace al asistente y si toca llevar a él. Solo se lleva una vez, y solo a un nodo recién
 * instalado (sin ninguna trampa): a quien ya lo tenía en marcha y se actualiza no se le
 * interrumpe, le queda el enlace en el menú.
 */
export async function resumenConfiguracion(): Promise<{ pendiente: boolean; llevar: boolean }> {
	const g = await leerConfiguracion();
	if (g.terminado) return { pendiente: false, llevar: false };
	return { pendiente: true, llevar: !g.visto && !(await hayTrampas()).alguna };
}

/* Al abrir el asistente: queda visto, y terminado si ya no le falta nada. */
export async function abrirConfiguracion(usuario: { correo: string; oid?: string | null }) {
	const g = await leerConfiguracion();
	const h = await hechos(usuario);
	const lista = pasos(h, g);
	if (!g.visto) await escribir({ ...g, visto: true });
	return { hechos: h, pasos: lista, terminado: g.terminado };
}

export type Resultado = { ok: true } | { ok: false; error: string };

async function apuntar(
	quien: string,
	id: IdPaso,
	valor: 'hecho' | 'omitido',
	accion: string
): Promise<void> {
	const g = await leerConfiguracion();
	await db.transaction(async (tx) => {
		const nuevo = { ...g, visto: true, confirmados: { ...g.confirmados, [id]: valor } };
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE, valor: nuevo })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: nuevo } });
		await tx.insert(s.auditoria).values({ quien, accion, detalle: { paso: id } });
	});
}

export async function confirmarPaso(quien: string, id: string): Promise<Resultado> {
	if (!MANUALES.includes(id as IdPaso))
		return { ok: false, error: 'That step cannot be confirmed.' };
	if (id === 'codigo' && !(await estadoCodigoEmergencia()))
		return {
			ok: false,
			error: 'This console has no emergency code yet. Create one in Settings first.'
		};
	await apuntar(quien, id as IdPaso, 'hecho', 'initial setup: step confirmed');
	return { ok: true };
}

export async function omitirPaso(quien: string, id: string): Promise<Resultado> {
	if (!OMITIBLES.includes(id as IdPaso))
		return { ok: false, error: 'That step cannot be skipped.' };
	await apuntar(quien, id as IdPaso, 'omitido', 'initial setup: step skipped');
	return { ok: true };
}

/* Solo se termina sin nada pendiente: cada paso está hecho o dejado para más adelante. */
export async function terminarConfiguracion(usuario: {
	correo: string;
	oid?: string | null;
}): Promise<Resultado> {
	const g = await leerConfiguracion();
	const faltan = pendientes(pasos(await hechos(usuario), g));
	if (faltan.length)
		return {
			ok: false,
			error:
				faltan.length === 1
					? 'One step is still pending. Complete it or skip it first.'
					: `${faltan.length} steps are still pending. Complete them or skip them first.`
		};
	await db.transaction(async (tx) => {
		const nuevo = { ...g, visto: true, terminado: new Date().toISOString() };
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE, valor: nuevo })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: nuevo } });
		await tx
			.insert(s.auditoria)
			.values({ quien: usuario.correo, accion: 'initial setup finished', detalle: {} });
	});
	return { ok: true };
}
