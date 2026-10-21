/*
 * Contraseñas que prueban los atacantes y alertas por el nombre de la empresa.
 *
 * Qué campo es la contraseña lo dice el manifiesto de cada trampa (Cowrie
 * hoy; cualquiera con login mañana), en el traductor de su vía. Se guarda en
 * su columna para poder reunirlas y contarlas.
 *
 * La alerta salta SOLO si la contraseña o el usuario contienen una de las
 * palabras que el cliente pone en Ajustes, tal cual: sin variantes ni
 * parecidos, para no inventar falsos positivos. Se ignoran mayúsculas y
 * tildes, nada más. Con alerta, el evento sube a crítico; la línea firmada
 * del sensor no se toca.
 */
import { and, desc, eq, ilike, isNotNull, sql } from 'drizzle-orm';
import type { Evento, Severidad } from '@sugardaddy/contrato';
import { db, schema as s } from './db';
import { honeycosas, traductorDeTrampa } from './catalogo';

export const MINIMO_PALABRA = 4;
const MAXIMO_PALABRAS = 20;
const MAXIMO_CONTRASENA = 256;

/* "Aldanza", "ALDANZA" y "Aldánza" son la misma palabra; "4ld4nz4" no. */
export const normalizar = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export async function palabras(): Promise<string[]> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'detonadores'));
	return (f?.valor as string[] | undefined) ?? [];
}

/*
 * El campo de contraseña de los eventos de una trampa, según el traductor de
 * su vía (traductorDeTrampa: sin vía, el del módulo).
 */
function camposContrasena() {
	const porId = new Map(honeycosas().map((h) => [h.id, h]));
	return (modulo: string, via?: string) => {
		const h = porId.get(modulo);
		return h && traductorDeTrampa(h, via)?.contrasena;
	};
}

export function alertaPara(
	contrasena: string | null,
	usuario: string | null,
	lista: string[]
): string | null {
	for (const p of lista) {
		const n = normalizar(p);
		if (contrasena && normalizar(contrasena).includes(n)) return `La contraseña contiene «${p}»`;
		if (usuario && normalizar(usuario).includes(n)) return `El usuario contiene «${p}»`;
	}
	return null;
}

/*
 * Lo que se guarda junto al evento: su contraseña, si la hay, y si es
 * alerta. campo: el de la contraseña en el detalle, según su manifiesto.
 */
export function credencialDe(
	e: Evento,
	campo: string | undefined,
	lista: string[]
): { contrasena: string | null; alerta: string | null; severidad: Severidad } {
	const v = campo ? e.detalle?.[campo] : undefined;
	const contrasena = typeof v === 'string' && v ? v.slice(0, MAXIMO_CONTRASENA) : null;
	const alerta = alertaPara(contrasena, e.origen.usuario ?? null, lista);
	return { contrasena, alerta, severidad: alerta ? 'critica' : e.severidad };
}

/*
 * Para la recepción: lo que no cambia entre eventos se lee una vez por
 * entrega. via: la de la trampa del evento, si se sabe.
 */
export async function preparar() {
	const campo = camposContrasena();
	const lista = await palabras();
	return (e: Evento, via?: string) => credencialDe(e, campo(e.trampa.modulo, via), lista);
}

/*
 * Vuelve a calcular contraseña, alerta y severidad de todos los eventos con
 * usuario o contraseña: al cambiar las palabras, o al llegar esta versión
 * (los eventos anteriores no tenían la contraseña aparte). Uno de prueba
 * («Probar», §8.3) nunca es alerta: conserva la severidad de su sensor.
 */
export async function recalcular() {
	const calcular = await preparar();
	/* La vía de cada trampa; la de una ya retirada no se sabe. */
	const vias = new Map(
		(await db.select({ id: s.trampas.id, via: s.trampas.via }).from(s.trampas)).map((t) => [
			t.id,
			t.via
		])
	);
	let desde = '';
	let cambiados = 0;
	for (;;) {
		const filas = await db
			.select({
				id: s.eventos.id,
				linea: s.eventos.linea,
				contrasena: s.eventos.contrasena,
				alerta: s.eventos.alerta,
				severidad: s.eventos.severidad,
				prueba: s.eventos.prueba
			})
			.from(s.eventos)
			.where(and(eq(s.eventos.accion, 'autenticacion'), sql`${s.eventos.id}::text > ${desde}`))
			.orderBy(sql`${s.eventos.id}::text`)
			.limit(1000);
		if (!filas.length) break;
		for (const f of filas) {
			const { senuelo, ...dato } = JSON.parse(f.linea);
			const e = (senuelo ? { ...dato, trampa: senuelo } : dato) as Evento;
			const leida = calcular(e, vias.get(e.trampa.id));
			const c = f.prueba ? { ...leida, alerta: null, severidad: e.severidad } : leida;
			if (c.contrasena !== f.contrasena || c.alerta !== f.alerta || c.severidad !== f.severidad) {
				await db.update(s.eventos).set(c).where(eq(s.eventos.id, f.id));
				cambiados++;
			}
		}
		desde = filas[filas.length - 1].id;
	}
	return cambiados;
}

/* Una vez por versión: rellena la contraseña de los eventos que llegaron antes de esta. */
export async function rellenarSiHaceFalta() {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'credenciales'));
	if ((f?.valor as { v?: number } | undefined)?.v === 1) return;
	await recalcular();
	await db
		.insert(s.ajustes)
		.values({ clave: 'credenciales', valor: { v: 1 } })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: { v: 1 } } });
}

export async function guardarPalabras(quien: string, texto: string) {
	const lista = [
		...new Set(
			texto
				.split(/[\n,]+/)
				.map((p) => p.trim())
				.filter(Boolean)
		)
	];
	const cortas = lista.filter((p) => normalizar(p).length < MINIMO_PALABRA);
	if (cortas.length)
		return {
			ok: false as const,
			error: `Cada palabra necesita al menos ${MINIMO_PALABRA} letras (${cortas.join(', ')}): con menos salta con cualquier cosa.`
		};
	if (lista.length > MAXIMO_PALABRAS)
		return { ok: false as const, error: `Como mucho ${MAXIMO_PALABRAS} palabras.` };
	await db
		.insert(s.ajustes)
		.values({ clave: 'detonadores', valor: lista })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: lista } });
	await db
		.insert(s.auditoria)
		.values({ quien, accion: 'palabras de alerta cambiadas', detalle: { palabras: lista } });
	return { ok: true as const, cambiados: await recalcular() };
}

/*
 * Todas las contraseñas probadas, de la más usada a la menos. Sin las de
 * «Probar» (§8.3): las escribe el propio cliente, no un atacante.
 */
export async function contrasenas(buscar = '') {
	const filtro = buscar.replace(/[%_\\]/g, '');
	return db
		.select({
			contrasena: s.eventos.contrasena,
			veces: sql<number>`count(*)::int`,
			ips: sql<number>`count(distinct ${s.eventos.ip})::int`,
			usuarios: sql<
				string[]
			>`(array_agg(distinct ${s.eventos.usuario}) filter (where ${s.eventos.usuario} is not null))[1:6]`,
			trampas: sql<string[]>`array_agg(distinct ${s.eventos.trampa})`,
			primera: sql<string>`min(${s.eventos.cuando})`,
			ultima: sql<string>`max(${s.eventos.cuando})`,
			alerta: sql<string | null>`max(${s.eventos.alerta})`
		})
		.from(s.eventos)
		.where(
			and(
				isNotNull(s.eventos.contrasena),
				eq(s.eventos.prueba, false),
				filtro ? ilike(s.eventos.contrasena, `%${filtro}%`) : undefined
			)
		)
		.groupBy(s.eventos.contrasena)
		.orderBy(desc(sql`max(${s.eventos.alerta}) is not null`), desc(sql`count(*)`))
		.limit(500);
}
