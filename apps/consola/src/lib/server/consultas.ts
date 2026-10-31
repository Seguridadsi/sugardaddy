/*
 * Todo lo que las páginas leen y escriben. Cada escritura que es una decisión
 * de una persona deja su línea en auditoría, en la misma transacción.
 */
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	like,
	or,
	sql
} from 'drizzle-orm';
import { EJECUTORES } from '@sugardaddy/contrato';
import type { Evento, PasosGenerados, Severidad, TipoTrampa } from '@sugardaddy/contrato';
import { env } from '$env/dynamic/private';
import { avisosSensor } from '$lib/capacidades';
import { entornoDe, type Entorno } from '$lib/entorno';
import { redYVlan } from '$lib/red';
import { db, schema as s } from './db';
import { honeycosas, traductorDeTrampa } from './catalogo';
import { estadosVisibles, type EstadoVisible } from './colocacion';
import type { Tx } from './destinos';
import { geo, type Geo } from './geo';
import { ipsTor } from './tor';
import type { CriterioTriaje } from './triaje-auto';

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
/* Los estados de triaje que un operador le pone a un evento (aparte de «sin triar»). */
export const ESTADOS_TRIAJE = ['revisado', 'falso-positivo', 'interesante'] as const;
export type EstadoTriaje = (typeof ESTADOS_TRIAJE)[number];
export type Triaje = { estado: EstadoTriaje; nota: string | null };

export type EventoConsola = Evento & {
	alerta?: string | null;
	prueba?: boolean;
	triaje?: Triaje | null;
};
const conAlerta = (f: {
	linea: string;
	severidad: string;
	alerta: string | null;
	prueba: boolean;
	triajeEstado?: EstadoTriaje | null;
	triajeNota?: string | null;
}): EventoConsola => ({
	...evento(f.linea),
	severidad: f.severidad as Severidad,
	alerta: f.alerta,
	prueba: f.prueba,
	triaje: f.triajeEstado ? { estado: f.triajeEstado, nota: f.triajeNota ?? null } : null
});
/*
 * Solo columnas de `eventos`: lo comparten resumen(), visita() y la lista. El
 * triaje (de otra tabla) NO va aquí; lo añade solo eventos(), que es quien hace
 * el leftJoin. Si se metiera aquí, resumen()/visita() —que no unen triaje—
 * fallarían al construir la consulta (regresión que cazó la revisión).
 */
const COLUMNAS = {
	linea: s.eventos.linea,
	severidad: s.eventos.severidad,
	alerta: s.eventos.alerta,
	prueba: s.eventos.prueba
};
/* Las columnas de triaje, solo para las consultas que unen la tabla `triaje`. */
const COLUMNAS_TRIAJE = { triajeEstado: s.triaje.estado, triajeNota: s.triaje.nota };

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

/*
 * El estado de triaje por el que se filtra: uno de los tres, «sin» (sin triar
 * todavía) o nada (todos). Lo valida la página; aquí se usa tal cual.
 */
export type FiltroTriaje = EstadoTriaje | 'sin';

/* Escapa los comodines de un LIKE/ILIKE para que el texto se busque literal. */
const sinComodines = (t: string) => t.replace(/[%_\\]/g, '\\$&');

export async function eventos(
	filtro: {
		desde?: Severidad;
		trampa?: string;
		origen?: string;
		/* El usuario EXACTO (lo que probó el atacante), no la búsqueda libre. */
		usuario?: string;
		/* Búsqueda libre dentro del evento (comando, usuario, URL, texto crudo…). */
		q?: string;
		triaje?: FiltroTriaje;
	} = {},
	limite = 200
) {
	const desde = SEVERIDADES.indexOf(filtro.desde ?? 'baja');
	const q = filtro.q?.trim();
	const filas = await db
		.select({ ...COLUMNAS, ...COLUMNAS_TRIAJE })
		.from(s.eventos)
		.leftJoin(s.triaje, eq(s.triaje.evento, s.eventos.id))
		.where(
			and(
				inArray(s.eventos.severidad, SEVERIDADES.slice(desde)),
				filtro.trampa ? eq(s.eventos.trampa, filtro.trampa) : undefined,
				filtro.origen ? like(s.eventos.ip, `${filtro.origen.replace(/[%_\\]/g, '')}%`) : undefined,
				filtro.usuario ? eq(s.eventos.usuario, filtro.usuario) : undefined,
				/* Dentro de la línea firmada (JSON): comando, usuario, URL, contraseña, crudo. */
				q ? ilike(s.eventos.linea, `%${sinComodines(q)}%`) : undefined,
				filtro.triaje === 'sin'
					? isNull(s.triaje.evento)
					: filtro.triaje
						? eq(s.triaje.estado, filtro.triaje)
						: undefined
			)
		)
		.orderBy(desc(s.eventos.cuando))
		.limit(limite);
	return filas.map((f) => conAlerta(f));
}

/*
 * Pone (o cambia) el triaje de un evento: la marca de quien lo revisó y una
 * nota. Upsert por evento (uno por evento). Queda en la auditoría. El evento
 * tiene que existir (la FK lo exige); si no, se avisa sin romper.
 */
export async function fijarTriaje(
	quien: string,
	evento: string,
	estado: EstadoTriaje,
	nota: string | null
): Promise<boolean> {
	const limpia = nota?.trim() ? nota.trim().slice(0, 2000) : null;
	return db.transaction(async (tx) => {
		const [ev] = await tx
			.select({ id: s.eventos.id })
			.from(s.eventos)
			.where(eq(s.eventos.id, evento));
		if (!ev) return false;
		await tx
			.insert(s.triaje)
			.values({ evento, estado, nota: limpia, quien })
			.onConflictDoUpdate({
				target: s.triaje.evento,
				set: { estado, nota: limpia, quien, cuando: new Date() }
			});
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'triaje de evento', detalle: { evento, estado } });
		return true;
	});
}

/* Quita el triaje de un evento (vuelve a «sin triar»). Queda en la auditoría. */
export async function quitarTriaje(quien: string, evento: string): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(s.triaje).where(eq(s.triaje.evento, evento));
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'triaje de evento retirado', detalle: { evento } });
	});
}

/* ---------------------------------------------------------------------------
 * Reglas de triaje automático (gratis). El cotejo y la aplicación al recibir
 * viven en triaje-auto.ts; aquí solo el CRUD con su auditoría. Cada cambio de
 * una regla es una decisión de una persona: deja su línea.
 * ------------------------------------------------------------------------- */

export type DatosReglaTriaje = {
	criterio: CriterioTriaje;
	valor: string;
	estado: EstadoTriaje;
	nota: string | null;
};

/* Todas las reglas de triaje, de la más antigua a la más nueva (orden en que casan). */
export function reglasTriaje() {
	return db.select().from(s.reglasTriaje).orderBy(asc(s.reglasTriaje.creado));
}

/* Crea una regla de triaje automático. Devuelve su id. */
export async function crearReglaTriaje(quien: string, v: DatosReglaTriaje): Promise<string> {
	const valor = v.valor.trim();
	const nota = v.nota?.trim() ? v.nota.trim().slice(0, 2000) : null;
	return db.transaction(async (tx) => {
		const [f] = await tx
			.insert(s.reglasTriaje)
			.values({ criterio: v.criterio, valor, estado: v.estado, nota, quien })
			.returning({ id: s.reglasTriaje.id });
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'regla de triaje creada',
			detalle: { criterio: v.criterio, valor, estado: v.estado }
		});
		return f.id;
	});
}

/* Borra una regla de triaje. Los triajes que ya puso se quedan (son del evento). false si ya no está. */
export async function borrarReglaTriaje(quien: string, id: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [f] = await tx
			.delete(s.reglasTriaje)
			.where(eq(s.reglasTriaje.id, id))
			.returning({ criterio: s.reglasTriaje.criterio, valor: s.reglasTriaje.valor });
		if (!f) return false;
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'regla de triaje borrada', detalle: { id, ...f } });
		return true;
	});
}

/* Enciende o apaga una regla de triaje sin tocar el resto. false si ya no existe. */
export async function cambiarActivaReglaTriaje(
	quien: string,
	id: string,
	activa: boolean
): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [f] = await tx
			.update(s.reglasTriaje)
			.set({ activa })
			.where(eq(s.reglasTriaje.id, id))
			.returning({ id: s.reglasTriaje.id });
		if (!f) return false;
		await tx.insert(s.auditoria).values({
			quien,
			accion: activa ? 'regla de triaje activada' : 'regla de triaje desactivada',
			detalle: { id }
		});
		return true;
	});
}

/*
 * Agrupa eventos repetidos para bajar el ruido visual: los que comparten IP de
 * origen, trampa y acción se colapsan en una fila, con su cuenta, el más
 * reciente como representante (la lista llega del más nuevo al más viejo) y el
 * lapso que cubren. Es solo una ayuda de la vista, sobre la página ya traída
 * (no toca la consulta ni la base): la cuenta es de lo que hay en pantalla. Con
 * eventos agrupados el triaje por evento se oculta (se marcaría el
 * representante, no el grupo).
 */
export type EventoAgrupado = EventoConsola & {
	repeticiones: number;
	desde: string;
	hasta: string;
};

export function agruparEventos(eventos: EventoConsola[]): EventoAgrupado[] {
	const grupos = new Map<string, EventoAgrupado>();
	const orden: string[] = [];
	for (const e of eventos) {
		const clave = `${e.origen.ip ?? '∅'}|${e.trampa.id}|${e.accion}`;
		const g = grupos.get(clave);
		if (!g) {
			grupos.set(clave, { ...e, repeticiones: 1, desde: e.cuando, hasta: e.cuando });
			orden.push(clave);
		} else {
			g.repeticiones++;
			if (e.cuando < g.desde) g.desde = e.cuando;
			if (e.cuando > g.hasta) g.hasta = e.cuando;
		}
	}
	return orden.map((k) => grupos.get(k)!);
}

/*
 * El perfil de una IP de origen: todo lo que ha hecho esa IP en el nodo, para
 * investigarla de un vistazo (cuántos eventos, desde cuándo, qué trampas tocó,
 * qué acciones, su geo) y los últimos eventos. Lectura. La IP se busca EXACTA
 * (no por prefijo como el filtro de la lista). Sin enriquecimiento externo
 * (AbuseIPDB/GreyNoise): eso es de pago y vive en el detalle del evento; aquí
 * solo la geolocalización local, que es gratis. null si no hay ningún evento.
 */
export async function perfilDeIp(ip: string) {
	const limpia = ip.trim();
	if (!limpia) return null;
	const deLaIp = eq(s.eventos.ip, limpia);
	/*
	 * Las cinco lecturas son independientes: van en paralelo (una sola espera, no
	 * cinco seguidas), que importa para una IP con muchísimos eventos. La de
	 * «recientes» se apoya en el índice compuesto (ip, cuando) para el ORDER BY …
	 * LIMIT. Las fechas salen como el resto de la consola: ISO con .toISOString().
	 */
	const [tot, porTrampa, porAccion, porSeveridad, recientesFilas] = await Promise.all([
		db
			.select({
				n: sql<number>`count(*)::int`,
				primera: sql<string>`min(${s.eventos.cuando})`,
				ultima: sql<string>`max(${s.eventos.cuando})`
			})
			.from(s.eventos)
			.where(deLaIp),
		db
			.select({ id: s.eventos.trampa, nombre: s.trampas.nombre, n: sql<number>`count(*)::int` })
			.from(s.eventos)
			.leftJoin(s.trampas, eq(s.trampas.id, s.eventos.trampa))
			.where(deLaIp)
			.groupBy(s.eventos.trampa, s.trampas.nombre)
			.orderBy(desc(sql`count(*)`)),
		db
			.select({ accion: s.eventos.accion, n: sql<number>`count(*)::int` })
			.from(s.eventos)
			.where(deLaIp)
			.groupBy(s.eventos.accion)
			.orderBy(desc(sql`count(*)`)),
		db
			.select({ severidad: s.eventos.severidad, n: sql<number>`count(*)::int` })
			.from(s.eventos)
			.where(deLaIp)
			.groupBy(s.eventos.severidad),
		db
			.select({ ...COLUMNAS, ...COLUMNAS_TRIAJE })
			.from(s.eventos)
			.leftJoin(s.triaje, eq(s.triaje.evento, s.eventos.id))
			.where(deLaIp)
			.orderBy(desc(s.eventos.cuando))
			.limit(50)
	]);
	const t0 = tot[0];
	if (!t0 || !t0.n) return null;
	const peor = porSeveridad.reduce<Severidad>(
		(a, r) =>
			SEVERIDADES.indexOf(r.severidad as Severidad) > SEVERIDADES.indexOf(a)
				? (r.severidad as Severidad)
				: a,
		'baja'
	);
	const recientes = recientesFilas.map((f) => conAlerta(f));
	return {
		total: t0.n,
		/* min/max de timestamptz: el driver lo da como Date; a ISO canónico para el navegador. */
		primera: new Date(t0.primera).toISOString(),
		ultima: new Date(t0.ultima).toISOString(),
		peor,
		trampas: porTrampa,
		acciones: porAccion,
		severidades: porSeveridad,
		recientes,
		geo: (await geoDe(recientes))[limpia] ?? null,
		/* La IP es la del motor de contenedores de un sensor, no la de un atacante. */
		oculta: recientes.some((e) => e.origen.oculta === true)
	};
}

/*
 * El perfil de un usuario (el que probó el atacante): todo lo que ha hecho ese
 * usuario en el nodo, para ver de un vistazo el reúso de credenciales entre IPs
 * (p. ej. «root» probado desde media internet). Igual que perfilDeIp pero por
 * `usuario`; en vez de una geo, las IP de origen desde las que se usó (con su
 * geo). Lectura, gratis. null si no hay ningún evento con ese usuario.
 */
export async function perfilDeUsuario(usuario: string) {
	if (!usuario.trim()) return null;
	/* Igualdad por el valor CRUDO: el usuario se guarda verbatim y puede llevar
	 * espacios; trim() solo vale para descartar el vacío, no para el cotejo. */
	const delUsuario = eq(s.eventos.usuario, usuario);
	const [tot, porTrampa, porAccion, porSeveridad, porOrigen, recientesFilas] = await Promise.all([
		db
			.select({
				n: sql<number>`count(*)::int`,
				primera: sql<string>`min(${s.eventos.cuando})`,
				ultima: sql<string>`max(${s.eventos.cuando})`
			})
			.from(s.eventos)
			.where(delUsuario),
		db
			.select({ id: s.eventos.trampa, nombre: s.trampas.nombre, n: sql<number>`count(*)::int` })
			.from(s.eventos)
			.leftJoin(s.trampas, eq(s.trampas.id, s.eventos.trampa))
			.where(delUsuario)
			.groupBy(s.eventos.trampa, s.trampas.nombre)
			.orderBy(desc(sql`count(*)`)),
		db
			.select({ accion: s.eventos.accion, n: sql<number>`count(*)::int` })
			.from(s.eventos)
			.where(delUsuario)
			.groupBy(s.eventos.accion)
			.orderBy(desc(sql`count(*)`)),
		db
			.select({ severidad: s.eventos.severidad, n: sql<number>`count(*)::int` })
			.from(s.eventos)
			.where(delUsuario)
			.groupBy(s.eventos.severidad),
		/*
		 * Las IP de origen desde las que se usó el usuario, las más activas primero.
		 * `oculta` marca la IP del motor de contenedores (no es la de un atacante): el
		 * flag vive en la línea firmada, así que se saca con bool_or sobre el JSON. Se
		 * piden 21 para saber si hay más de 20 sin un count aparte.
		 */
		db
			.select({
				ip: s.eventos.ip,
				n: sql<number>`count(*)::int`,
				oculta: sql<boolean>`bool_or(((${s.eventos.linea})::jsonb #>> '{origen,oculta}') = 'true')`
			})
			.from(s.eventos)
			.where(and(delUsuario, isNotNull(s.eventos.ip)))
			.groupBy(s.eventos.ip)
			.orderBy(desc(sql`count(*)`))
			.limit(21),
		db
			.select({ ...COLUMNAS, ...COLUMNAS_TRIAJE })
			.from(s.eventos)
			.leftJoin(s.triaje, eq(s.triaje.evento, s.eventos.id))
			.where(delUsuario)
			.orderBy(desc(s.eventos.cuando))
			.limit(50)
	]);
	const t0 = tot[0];
	if (!t0 || !t0.n) return null;
	const peor = porSeveridad.reduce<Severidad>(
		(a, r) =>
			SEVERIDADES.indexOf(r.severidad as Severidad) > SEVERIDADES.indexOf(a)
				? (r.severidad as Severidad)
				: a,
		'baja'
	);
	const masOrigenes = porOrigen.length > 20;
	const origenesTop = porOrigen.slice(0, 20);
	const geos = await geoDe(origenesTop.map((o) => ({ origen: { ip: o.ip } }) as Evento));
	const recientes = recientesFilas.map((f) => conAlerta(f));
	return {
		total: t0.n,
		primera: new Date(t0.primera).toISOString(),
		ultima: new Date(t0.ultima).toISOString(),
		peor,
		trampas: porTrampa,
		acciones: porAccion,
		severidades: porSeveridad,
		origenes: origenesTop.map((o) => ({
			ip: o.ip as string,
			n: o.n,
			oculta: o.oculta === true,
			geo: geos[o.ip as string] ?? null
		})),
		/* Hay más de 20 IP de origen distintas (se muestra «20+»). */
		masOrigenes,
		recientes,
		/* Geo de TODOS los recientes (no solo del top de orígenes), para ListaEventos. */
		geosRecientes: await geoDe(recientes)
	};
}

/*
 * Los eventos en columnas planas, para que el cliente se baje sus datos en CSV
 * (edición community: sacar tus datos tú mismo). Usa las COPIAS denormalizadas
 * (las mismas con las que se filtra), no la línea firmada: salen listas para una
 * hoja de cálculo sin parsear nada. Mismo filtro que `eventos`, con un tope alto.
 */
export async function eventosPlanos(
	filtro: {
		desde?: Severidad;
		trampa?: string;
		origen?: string;
		usuario?: string;
		q?: string;
		triaje?: FiltroTriaje;
	} = {},
	limite = 50_000
) {
	const desde = SEVERIDADES.indexOf(filtro.desde ?? 'baja');
	const q = filtro.q?.trim();
	return db
		.select({
			cuando: s.eventos.cuando,
			severidad: s.eventos.severidad,
			sensor: s.eventos.sensor,
			trampa: s.eventos.trampa,
			modulo: s.eventos.modulo,
			tipo: s.eventos.tipo,
			accion: s.eventos.accion,
			ip: s.eventos.ip,
			usuario: s.eventos.usuario,
			contrasena: s.eventos.contrasena,
			conexionEstablecida: s.eventos.conexionEstablecida,
			alerta: s.eventos.alerta,
			prueba: s.eventos.prueba,
			triaje: s.triaje.estado
		})
		.from(s.eventos)
		.leftJoin(s.triaje, eq(s.triaje.evento, s.eventos.id))
		.where(
			and(
				inArray(s.eventos.severidad, SEVERIDADES.slice(desde)),
				filtro.trampa ? eq(s.eventos.trampa, filtro.trampa) : undefined,
				filtro.origen ? like(s.eventos.ip, `${filtro.origen.replace(/[%_\\]/g, '')}%`) : undefined,
				filtro.usuario ? eq(s.eventos.usuario, filtro.usuario) : undefined,
				q ? ilike(s.eventos.linea, `%${sinComodines(q)}%`) : undefined,
				filtro.triaje === 'sin'
					? isNull(s.triaje.evento)
					: filtro.triaje
						? eq(s.triaje.estado, filtro.triaje)
						: undefined
			)
		)
		.orderBy(desc(s.eventos.cuando))
		.limit(limite);
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
 * Opt-in de auto-actualización (solo nodos sin gestión). La persona puede
 * activarla en el primer arranque, en Ajustes, o cuando el banner de versión
 * nueva se la vuelve a ofrecer: siempre disponible. A cambio deja su correo
 * (dato personal: se guarda con la fecha del consentimiento). `decidido` marca
 * que ya se le preguntó, para no insistir con el aviso de primer arranque.
 */
export type AutoActualizar = {
	decidido: boolean;
	activo: boolean;
	correo: string | null;
	consentimiento: string | null;
};

export const autoActualizar = () =>
	ajuste<AutoActualizar>('auto-actualizar', {
		decidido: false,
		activo: false,
		correo: null,
		consentimiento: null
	});

export async function guardarAutoActualizar(quien: string, valor: AutoActualizar) {
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: 'auto-actualizar', valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		/* En la auditoría NO se guarda el correo, solo si se dio. */
		await tx.insert(s.auditoria).values({
			quien,
			accion: valor.activo ? 'auto-actualización activada' : 'auto-actualización desactivada',
			detalle: { correo: valor.correo ? 'dado' : 'no' }
		});
	});
}

/*
 * Webhook de eventos (edición community: «saca tus datos tú mismo»). Dispara
 * cada evento nuevo, tal cual, a una URL del cliente; él monta su fiabilidad
 * (NATS, su SIEM…) al otro lado. La entrega GESTIONADA y fiable (reglas,
 * reintentos, Sentinel/Teams/Slack/correo con formato) es de pago (Avisos y SIEM).
 * `secreto`, si se pone, firma cada envío con HMAC-SHA256 para que el cliente
 * pueda comprobar que viene del nodo.
 */
export type Webhook = { url: string | null; activo: boolean; secreto: string | null };

export const webhook = () =>
	ajuste<Webhook>('webhook', { url: null, activo: false, secreto: null });

/* Hasta dónde se ha enviado ya (marca de agua): el evento con (recibido, id) más
 * reciente que salió. El par evita duplicar o perder los que comparten recibido. */
export type WebhookPos = { recibido: string | null; id: string | null };

export const webhookPos = () => ajuste<WebhookPos>('webhook-pos', { recibido: null, id: null });

export async function guardarWebhookPos(pos: WebhookPos) {
	await db
		.insert(s.ajustes)
		.values({ clave: 'webhook-pos', valor: pos })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: pos } });
}

export async function guardarWebhook(quien: string, valor: Webhook) {
	const previo = await webhook();
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: 'webhook', valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		/* Al ACTIVARLO, el reloj empieza ahora: solo se envían los eventos nuevos,
		 * no se vuelca el histórico de golpe. */
		if (valor.activo && !previo.activo) {
			const pos: WebhookPos = { recibido: new Date().toISOString(), id: '' };
			await tx
				.insert(s.ajustes)
				.values({ clave: 'webhook-pos', valor: pos })
				.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: pos } });
		}
		/* En la auditoría va la URL (es del propio cliente), pero del secreto solo si lo hay. */
		await tx.insert(s.auditoria).values({
			quien,
			accion: valor.activo ? 'webhook de eventos activado' : 'webhook de eventos desactivado',
			detalle: { url: valor.url, secreto: valor.secreto ? 'sí' : 'no' }
		});
	});
}

/* Los eventos a partir de la marca de agua, en orden de llegada, para el webhook. */
export async function eventosParaWebhook(pos: WebhookPos, limite = 200) {
	const base = pos.recibido ? new Date(pos.recibido) : new Date(0);
	/* `id` es UUID: cuando aún no se ha enviado nada (id vacío/nulo) se usa el
	 * UUID cero como centinela, que es menor que cualquier id real. */
	const idBase = pos.id || '00000000-0000-0000-0000-000000000000';
	return db
		.select({ id: s.eventos.id, linea: s.eventos.linea, recibido: s.eventos.recibido })
		.from(s.eventos)
		.where(
			or(gt(s.eventos.recibido, base), and(eq(s.eventos.recibido, base), gt(s.eventos.id, idBase)))
		)
		.orderBy(asc(s.eventos.recibido), asc(s.eventos.id))
		.limit(limite);
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
 * El entorno efectivo de una trampa y de dónde sale: el suyo si lo tiene, si no
 * el de su sensor (lib/entorno.ts). Un único sitio para la ficha de la trampa y
 * para el motor (la guarda y el filtrado de reglas por entorno). null si la
 * trampa ya no existe.
 */
export async function entornoDeTrampa(
	id: string
): Promise<{ propio: Entorno | null; sensor: Entorno | null; efectivo: Entorno | null } | null> {
	const [t] = await db
		.select({ entorno: s.trampas.entorno, sensor: s.trampas.sensor })
		.from(s.trampas)
		.where(eq(s.trampas.id, id));
	if (!t) return null;
	let sensor: Entorno | null = null;
	if (t.sensor) {
		const [sen] = await db
			.select({ entorno: s.sensores.entorno })
			.from(s.sensores)
			.where(eq(s.sensores.id, t.sensor));
		sensor = (sen?.entorno as Entorno | null) ?? null;
	}
	const propio = t.entorno as Entorno | null;
	return { propio, sensor, efectivo: entornoDe(propio, sensor) };
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
