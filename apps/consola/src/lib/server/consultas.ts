/*
 * Todo lo que las páginas leen y escriben. Cada escritura que es una decisión
 * de una persona deja su línea en auditoría, en la misma transacción.
 */
import { and, desc, eq, gte, inArray, like, sql } from 'drizzle-orm';
import { EJECUTORES } from '@sugardaddy/contrato';
import type { Evento, PasosGenerados, Severidad, TipoTrampa } from '@sugardaddy/contrato';
import { env } from '$env/dynamic/private';
import { avisosSensor } from '$lib/capacidades';
import { redYVlan } from '$lib/red';
import { db, schema as s } from './db';
import { honeycosas, traductorDeTrampa } from './catalogo';
import { estadosVisibles, type EstadoVisible } from './colocacion';
import type { Tx } from './destinos';
import { geo, type Geo } from './geo';
import { ipsTor } from './tor';

export const SEVERIDADES = ['baja', 'media', 'alta', 'critica'] as const;
const DIA = 86_400_000;
/* Un sensor que no late en este tiempo se da por caído. */
const LATIDO_MAXIMO = 5 * 60_000;

/* La línea guardada es el evento: se validó contra el contrato al recibirla. */
/* Las líneas guardadas antes de la 0.8.0 llaman "senuelo" a la trampa. */
function evento(linea: string): Evento {
	const { senuelo, ...e } = JSON.parse(linea);
	return senuelo ? { ...e, trampa: senuelo } : e;
}

/*
 * Lo que enseña la consola: el evento firmado más lo que la consola le ha
 * añadido al recibirlo (si es alerta y por qué, y entonces su severidad sube;
 * si lo provocó «Probar»).
 */
export type EventoConsola = Evento & { alerta?: string | null; prueba?: boolean };
const conAlerta = (f: {
	linea: string;
	severidad: string;
	alerta: string | null;
	prueba: boolean;
}): EventoConsola => ({
	...evento(f.linea),
	severidad: f.severidad as Severidad,
	alerta: f.alerta,
	prueba: f.prueba
});
const COLUMNAS = {
	linea: s.eventos.linea,
	severidad: s.eventos.severidad,
	alerta: s.eventos.alerta,
	prueba: s.eventos.prueba
};

const vivo = (ultimo: Date | null, ahora = Date.now()) =>
	!!ultimo && ahora - ultimo.getTime() < LATIDO_MAXIMO;

async function ajuste<T>(clave: string, porDefecto: T): Promise<T> {
	const [fila] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return (fila?.valor as T) ?? porDefecto;
}

export async function auditar(
	quien: string,
	accion: string,
	detalle: Record<string, unknown> = {}
) {
	await db.insert(s.auditoria).values({ quien, accion, detalle });
}

export async function cabecera() {
	const [{ n }] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(s.aprobaciones)
		.where(eq(s.aprobaciones.estado, 'pendiente'));
	const nodo = await ajuste('nodo', { nombre: 'Nodo sin nombre', nodo: 'nodo', version: '0.0.0' });
	return {
		/* En una imagen, la versión es la de la imagen: es lo que de verdad está corriendo. */
		cliente: { ...nodo, version: env.SUGARDADDY_VERSION ?? nodo.version },
		pendientes: n
	};
}

export async function nombresTrampas(): Promise<Record<string, string>> {
	const filas = await db.select({ id: s.trampas.id, nombre: s.trampas.nombre }).from(s.trampas);
	return Object.fromEntries(filas.map((f) => [f.id, f.nombre]));
}

export async function eventos(
	filtro: { desde?: Severidad; trampa?: string; origen?: string } = {},
	limite = 200
) {
	const desde = SEVERIDADES.indexOf(filtro.desde ?? 'baja');
	const filas = await db
		.select(COLUMNAS)
		.from(s.eventos)
		.where(
			and(
				inArray(s.eventos.severidad, SEVERIDADES.slice(desde)),
				filtro.trampa ? eq(s.eventos.trampa, filtro.trampa) : undefined,
				filtro.origen ? like(s.eventos.ip, `${filtro.origen.replace(/[%_\\]/g, '')}%`) : undefined
			)
		)
		.orderBy(desc(s.eventos.cuando))
		.limit(limite);
	return filas.map((f) => conAlerta(f));
}

export async function totalEventos() {
	const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.eventos);
	return n;
}

export async function resumen() {
	const ahora = Date.now();
	const dia = (
		await db
			.select(COLUMNAS)
			.from(s.eventos)
			.where(gte(s.eventos.cuando, new Date(ahora - DIA)))
			.orderBy(desc(s.eventos.cuando))
	).map((f) => conAlerta(f));

	const peor = (a: string | undefined, b: string) =>
		!a || SEVERIDADES.indexOf(b as Severidad) > SEVERIDADES.indexOf(a as Severidad) ? b : a;

	/* oculta: la IP es la del motor de contenedores de un sensor, no la de un atacante. */
	const porOrigen = new Map<
		string,
		{ ip: string; eventos: number; peor: string; oculta: boolean }
	>();
	const peorPorTrampa: Record<string, string> = {};
	for (const e of dia) {
		peorPorTrampa[e.trampa.id] = peor(peorPorTrampa[e.trampa.id], e.severidad);
		if (!e.origen.ip) continue;
		const o = porOrigen.get(e.origen.ip) ?? {
			ip: e.origen.ip,
			eventos: 0,
			peor: 'baja',
			oculta: false
		};
		o.eventos++;
		o.peor = peor(o.peor, e.severidad);
		o.oculta ||= e.origen.oculta === true;
		porOrigen.set(e.origen.ip, o);
	}

	const sensores = await db.select().from(s.sensores).orderBy(s.sensores.creado);
	const todas = await db.select().from(s.trampas).orderBy(s.trampas.creado);
	/* Una trampa a mano sale con el sensor que recibe su señal, y dice en qué destino está. */
	const destinos = new Map(
		(await db.select({ id: s.destinos.id, nombre: s.destinos.nombre }).from(s.destinos)).map(
			(d) => [d.id, d.nombre]
		)
	);
	/* Lo que ve el cliente de cada una (§8.2): «activa» es comprobada, y nada más. */
	const estados = await estadosVisibles(ahora);
	const trampas = todas.flatMap((t) => {
		const estado = estados.get(t.id);
		return estado ? [{ ...t, estado }] : [];
	});
	const [primera] = await db
		.select({ objetivo: s.aprobaciones.objetivo })
		.from(s.aprobaciones)
		.where(eq(s.aprobaciones.estado, 'pendiente'))
		.orderBy(desc(s.aprobaciones.creado))
		.limit(1);

	const top = [...porOrigen.values()].sort((a, b) => b.eventos - a.eventos).slice(0, 5);
	const geos = await geoDe(top.map((o) => ({ origen: { ip: o.ip } }) as Evento));
	return {
		ahora,
		geo: await mapaDeOrigenes(),
		cifras: {
			eventos: dia.length,
			criticos: dia.filter((e) => e.severidad === 'critica').length,
			origenes: porOrigen.size,
			activos: trampas.filter((t) => t.estado.activa).length,
			total: trampas.length
		},
		primera: primera ?? null,
		ultimos: dia.slice(0, 8),
		origenes: top.map((o) => ({ ...o, geo: geos[o.ip] ?? null })),
		sensores: sensores.map((x) => ({
			id: x.id,
			nombre: x.nombre,
			red: redYVlan(x.red, x.vlan),
			vivo: vivo(x.ultimoLatido, ahora),
			ultimoLatido: x.ultimoLatido?.toISOString() ?? null,
			avisos: avisosSensor(x.capacidades),
			trampas: trampas
				.filter((y) => y.sensor === x.id)
				.map((y) => ({
					id: y.id,
					nombre: y.nombre,
					tipo: y.tipo,
					donde: y.donde,
					estado: y.estado,
					peor: peorPorTrampa[y.id] ?? null,
					aMano: EJECUTORES[y.ejecutor]?.corre === 'consola',
					destino: (y.destino && destinos.get(y.destino)) ?? null
				}))
		})),
		nombres: Object.fromEntries(trampas.map((x) => [x.id, x.nombre]))
	};
}

/* La lista de Trampas: cada una con sus eventos de las últimas 24 h y lo que ve el cliente (§8.2). */
export async function trampasConEventos() {
	const desde = new Date(Date.now() - DIA);
	const filas = await db
		.select({
			id: s.trampas.id,
			nombre: s.trampas.nombre,
			modulo: s.trampas.modulo,
			tipo: s.trampas.tipo,
			donde: s.trampas.donde,
			activo: s.trampas.activo,
			ejecutor: s.trampas.ejecutor,
			colocacion: s.trampas.colocacion,
			sensorNombre: s.sensores.nombre,
			destinoNombre: s.destinos.nombre,
			eventos: sql<number>`(select count(*)::int from ${s.eventos} e where e.trampa = ${s.trampas.id} and e.cuando >= ${desde.toISOString()}::timestamptz)`
		})
		.from(s.trampas)
		.innerJoin(s.sensores, eq(s.sensores.id, s.trampas.sensor))
		.leftJoin(s.destinos, eq(s.destinos.id, s.trampas.destino))
		.orderBy(s.trampas.creado);
	const estados = filas.length ? await estadosVisibles() : new Map<string, EstadoVisible>();
	return filas.flatMap((f) => {
		const estado = estados.get(f.id);
		/*
		 * Una trampa a mano (manual@1) no la pone ningún sensor: la pone el
		 * cliente en su destino, y no se para (§6.3). Su sensor es el que
		 * recibe su señal.
		 */
		const aMano = EJECUTORES[f.ejecutor]?.corre === 'consola';
		const pausable = EJECUTORES[f.ejecutor]?.pausable ?? false;
		return estado ? [{ ...f, estado, aMano, pausable }] : [];
	});
}

export async function existeTrampa(id: string) {
	return (
		(await db.select({ id: s.trampas.id }).from(s.trampas).where(eq(s.trampas.id, id))).length > 0
	);
}

/*
 * Lo que hace falta para quitar lo sembrado sin la fila (§9.1): los pasos de
 * retirada con su lenguaje y sus variables. Va en la auditoría cada vez que
 * se generan los pasos de una trampa a mano: tras una vuelta atrás, la
 * consola anterior la retira borrando la fila, y con ella trampas.manual; la
 * auditoría solo crece.
 */
export const paraRetirar = (p: PasosGenerados) => ({
	lenguaje: p.lenguaje,
	variables: p.variables,
	pasos: p.retirada
});

/*
 * Guarda una trampa nueva con su línea de auditoría: dónde (destino), cómo
 * (vía y ejecutor) y qué sensor la despliega o recibe su señal, que ya ha
 * decidido el elector (alta.ts). Una a mano llega con sus pasos (manual), la
 * trampa de la que recibe la señal (senalTrampa) y su «donde»; en la
 * auditoría van la huella de los pasos y lo que hace falta para quitarla
 * (paraRetirar), no todos los pasos. Dentro de la transacción del alta, si se
 * le pasa. false si ya hay una trampa con ese id (dos altas a la vez).
 */
export async function crearTrampa(
	quien: string,
	v: {
		id: string;
		nombre: string;
		modulo: string;
		tipo: TipoTrampa;
		destino: string;
		/* La vía con que se pone, con su id de hoy: un v2 puede llamarla de otra forma. */
		via: string;
		ejecutor: string;
		sensor: string;
		parametros: Record<string, unknown>;
		manual?: PasosGenerados;
		senalTrampa?: string | null;
		donde?: string;
	},
	bd?: Tx
): Promise<boolean> {
	const { manual, donde = 'desplegando…', ...fila } = v;
	const crear = async (tx: Tx) => {
		const [f] = await tx
			.insert(s.trampas)
			.values({ ...fila, donde, ...(manual ? { manual } : {}) })
			.onConflictDoNothing({ target: s.trampas.id })
			.returning({ id: s.trampas.id });
		if (!f) return false;
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'trampa creada',
			detalle: {
				...fila,
				...(manual ? { pasos: manual.sha256, retirar: paraRetirar(manual) } : {})
			}
		});
		return true;
	};
	return bd ? crear(bd) : db.transaction(crear);
}

export async function reglasYAprobaciones() {
	const reglas = await db.select().from(s.reglas).orderBy(s.reglas.creado);
	const pendientes = await db
		.select({
			id: s.aprobaciones.id,
			regla: s.aprobaciones.regla,
			respuesta: s.aprobaciones.respuesta,
			objetivo: s.aprobaciones.objetivo,
			cuando: s.aprobaciones.creado,
			linea: s.eventos.linea
		})
		.from(s.aprobaciones)
		.innerJoin(s.eventos, eq(s.eventos.id, s.aprobaciones.evento))
		.where(eq(s.aprobaciones.estado, 'pendiente'))
		.orderBy(desc(s.aprobaciones.creado));
	return {
		reglas,
		pendientes: pendientes.map(({ linea, cuando, ...a }) => ({
			...a,
			cuando: cuando.toISOString(),
			evento: evento(linea)
		}))
	};
}

export async function decidirAprobacion(quien: string, id: string, aprobar: boolean) {
	if (!/^[0-9a-f-]{36}$/.test(id)) return null;
	return db.transaction(async (tx) => {
		const [a] = await tx
			.update(s.aprobaciones)
			.set({
				estado: aprobar ? 'aprobada' : 'rechazada',
				decididoPor: quien,
				decididoEn: new Date()
			})
			.where(and(eq(s.aprobaciones.id, id), eq(s.aprobaciones.estado, 'pendiente')))
			.returning();
		if (!a) return null;
		await tx.insert(s.auditoria).values({
			quien,
			accion: aprobar ? 'respuesta aprobada' : 'respuesta rechazada',
			detalle: { aprobacion: a.id, respuesta: a.respuesta, objetivo: a.objetivo }
		});
		return a;
	});
}

export async function listasDe(lista: 'negra' | 'blanca') {
	const todas = await db.select().from(s.listas).orderBy(desc(s.listas.creado));
	return {
		entradas: todas
			.filter((l) => l.lista === lista)
			.map((l) => ({ ...l, caduca: l.caduca?.toISOString() ?? null })),
		cuentas: {
			negra: todas.filter((l) => l.lista === 'negra').length,
			blanca: todas.filter((l) => l.lista === 'blanca').length
		},
		blancasLocales: todas.filter((l) => l.lista === 'blanca' && l.ambito === 'local').length
	};
}

export async function anadirALista(
	quien: string,
	v: {
		valor: string;
		clase: 'ip' | 'red';
		lista: 'negra' | 'blanca';
		motivo: string;
		caduca: Date | null;
	}
) {
	return db.transaction(async (tx) => {
		const [fila] = await tx
			.insert(s.listas)
			.values({ ...v, ambito: 'local', quien })
			.onConflictDoNothing()
			.returning();
		if (!fila) return false;
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: `añadido a lista ${v.lista}`, detalle: v });
		return true;
	});
}

export type Comparticion = { compartir: boolean; recibir: boolean };

export const comparticion = () =>
	ajuste<Comparticion>('comparticion', { compartir: false, recibir: false });

export async function guardarComparticion(quien: string, valor: Comparticion) {
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: 'comparticion', valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		await tx.insert(s.auditoria).values({ quien, accion: 'compartición cambiada', detalle: valor });
	});
}

/*
 * Aviso de versión nueva (solo nodos sin gestión; lo mueve lib/server/actualizaciones).
 * El interruptor lo ve la persona en Ajustes; por defecto, activado.
 */
export const buscarActualizaciones = () => ajuste<boolean>('buscar-actualizaciones', true);

export async function guardarBuscarActualizaciones(quien: string, activo: boolean) {
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: 'buscar-actualizaciones', valor: activo })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: activo } });
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'aviso de versiones', detalle: { activo } });
	});
}

/* La versión nueva vista en el repo público, o { version: null } si no hay o no aplica. */
export const actualizacionDisponible = () =>
	ajuste<{ version: string | null }>('actualizacion-disponible', { version: null });

export async function guardarActualizacionDisponible(version: string | null) {
	const valor = { version };
	await db
		.insert(s.ajustes)
		.values({ clave: 'actualizacion-disponible', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

/*
 * Un evento y la visita entera a la que pertenece: todo lo que hizo el mismo
 * atacante en la misma conexión, en orden. Qué campo agrupa la visita y cómo
 * se llaman las cosas lo dice el manifiesto del módulo, no la consola: el
 * traductor de la vía de su trampa (el del módulo si ya no está).
 */
export async function visita(id: string) {
	const [fila] = await db.select().from(s.eventos).where(eq(s.eventos.id, id));
	if (!fila) return null;
	const e = conAlerta(fila);
	const h = honeycosas().find((x) => x.id === e.trampa.modulo);
	const [t] = await db
		.select({ via: s.trampas.via })
		.from(s.trampas)
		.where(and(eq(s.trampas.id, fila.trampa), eq(s.trampas.sensor, fila.sensor)));
	const m = h && traductorDeTrampa(h, t?.via);
	const campo = m?.sesion;
	const sesion = campo ? e.detalle?.[campo] : undefined;
	const eventosVisita =
		typeof sesion === 'string'
			? (
					await db
						.select(COLUMNAS)
						.from(s.eventos)
						.where(
							and(
								eq(s.eventos.sensor, fila.sensor),
								eq(s.eventos.trampa, fila.trampa),
								sql`(${s.eventos.linea})::jsonb #>> ${`{detalle,${campo}}`}::text[] = ${sesion}`
							)
						)
						.orderBy(s.eventos.cuando)
						.limit(500)
				).map((f) => conAlerta(f))
			: [e];
	return {
		evento: e,
		geo: (await geoDe([e]))[e.origen.ip ?? ''] ?? null,
		visita: eventosVisita,
		campoSesion: campo ?? null,
		campoAccion: m?.accion.campo ?? null,
		etiquetas: m?.etiquetas ?? {}
	};
}

/* Las etiquetas de cada módulo, para que la lista diga "Contraseña" y no "password". */
export function etiquetasModulos(): Record<
	string,
	{ etiquetas: Record<string, string>; accion: string; resumen: string[] | null }
> {
	return Object.fromEntries(
		honeycosas().flatMap((h) => {
			const t = traductorDeTrampa(h);
			return t
				? [
						[
							h.id,
							{ etiquetas: t.etiquetas ?? {}, accion: t.accion.campo, resumen: t.resumen ?? null }
						]
					]
				: [];
		})
	);
}

export async function trampa(id: string) {
	const [f] = await db.select().from(s.trampas).where(eq(s.trampas.id, id));
	return f ?? null;
}

/*
 * Cambiar los ajustes de una trampa desplegada: el sensor rehace su
 * contenedor en la siguiente consulta. Dentro de la transacción que ya ha
 * vuelto a pasar el elector (alta.ts), si se le pasa.
 */
export async function modificarTrampa(
	quien: string,
	id: string,
	v: { nombre: string; parametros: Record<string, unknown> },
	bd?: Tx
) {
	const modificar = async (tx: Tx) => {
		await tx
			.update(s.trampas)
			.set({ ...v, donde: 'aplicando cambios…' })
			.where(eq(s.trampas.id, id));
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'trampa modificada', detalle: { id, ...v } });
	};
	await (bd ? modificar(bd) : db.transaction(modificar));
}

/* Para pintar junto a cada evento de dónde viene su IP (solo las públicas). */
export async function geoDe(eventos: Evento[]): Promise<Record<string, Geo & { tor: boolean }>> {
	const tor = await ipsTor();
	const r: Record<string, Geo & { tor: boolean }> = {};
	for (const e of eventos) {
		const g = e.origen.ip ? geo(e.origen.ip) : null;
		if (g && e.origen.ip) r[e.origen.ip] = { ...g, tor: tor.has(e.origen.ip) };
	}
	return r;
}

export const DIAS_MAPA = 30;

/*
 * Orígenes: las IP públicas de los últimos 30 días, por país y por
 * organización. Las internas no salen: no tienen sitio en un mapa, y para
 * ellas está el mapa de trampas por sensor.
 */
export async function mapaDeOrigenes() {
	const filas = await db
		.select({ ip: s.eventos.ip, n: sql<number>`count(*)::int` })
		.from(s.eventos)
		.where(gte(s.eventos.cuando, new Date(Date.now() - DIAS_MAPA * DIA)))
		.groupBy(s.eventos.ip);
	const paises = new Map<string, { pais: string; eventos: number; ips: number }>();
	const orgs = new Map<
		string,
		{ organizacion: string; asn: number | null; eventos: number; ips: number }
	>();
	let publicas = 0;
	for (const f of filas) {
		const g = geo(f.ip);
		if (!g) continue;
		publicas++;
		if (g.pais) {
			const p = paises.get(g.pais) ?? { pais: g.pais, eventos: 0, ips: 0 };
			p.eventos += f.n;
			p.ips++;
			paises.set(g.pais, p);
		}
		if (g.organizacion) {
			const o = orgs.get(g.organizacion) ?? {
				organizacion: g.organizacion,
				asn: g.asn,
				eventos: 0,
				ips: 0
			};
			o.eventos += f.n;
			o.ips++;
			orgs.set(g.organizacion, o);
		}
	}
	const orden = <T extends { eventos: number }>(m: Map<string, T>) =>
		[...m.values()].sort((a, b) => b.eventos - a.eventos);
	return {
		dias: DIAS_MAPA,
		ipsPublicas: publicas,
		paises: orden(paises),
		organizaciones: orden(orgs).slice(0, 6)
	};
}
