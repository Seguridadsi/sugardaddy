/*
 * Destinos: los sitios donde se pone algo (docs/diseno/modulo-despliegue.md
 * §5). Una máquina con sensor se crea con su sensor (crearSensor); el resto
 * los describe el cliente con el formulario corto.
 *
 * El id se propone a partir del nombre, o del id del sensor, y si ya lo
 * tiene otro destino lleva sufijo (fs01-2). No depende del sensor: el
 * destino de un sensor se busca siempre por destinos.sensor.
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
	NOMBRE_HECHO,
	elegir,
	puertosPublicados,
	validarParametros,
	valorHecho,
	valorVisible,
	viaDe
} from '@sugardaddy/contrato';
import type {
	CargaContenedor,
	ContextoElector,
	DescripcionDestino,
	Destino,
	Eleccion,
	Hechos,
	Honeycosa,
	Motivo,
	TipoDestino,
	TrampaDelCliente
} from '@sugardaddy/contrato';
import { avisosSensor } from '$lib/capacidades';
import { hechosNodo } from './balizas';
import { coberturaLicencia } from './candado';
import {
	EDICIONES,
	POSIX,
	POWERSHELL,
	PROTOCOLOS,
	camposDe,
	camposDelSensor,
	plataformaDe,
	sistemasDe,
	versionesWindows,
	HECHO_DE_CAMPO,
	type CampoDestino
} from '$lib/destinos';
import { CANDIDATOS, idDestino, slugDestino } from '../../../scripts/destinos.mjs';
import { EJECUTORES_CONSOLA, autorizados, honeycosas, nombresModulos } from './catalogo';
import { estadosVisibles, type EstadoVisible } from './colocacion';
import { db, schema as s } from './db';
import { hechosDe, type SensorDeHechos } from './hechos';

export { slugDestino };

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/* Donde se lee: la conexión de siempre o una transacción abierta. */
export type Bd = Tx | typeof db;

/* El destino de un sensor, o null. Siempre por destinos.sensor: su id puede ser otro (§5.2). */
export async function destinoDeSensor(sensor: string, tx: Tx | typeof db = db) {
	const [d] = await tx.select().from(s.destinos).where(eq(s.destinos.sensor, sensor));
	return d ?? null;
}

/*
 * El destino de una trampa, o null: el suyo o, si una consola anterior la
 * dejó sin destino, el de su sensor (la máquina donde corre).
 */
export async function destinoDeTrampa(
	t: Pick<typeof s.trampas.$inferSelect, 'destino' | 'sensor'>,
	tx: Bd = db
) {
	if (!t.destino) return destinoDeSensor(t.sensor, tx);
	const [d] = await tx.select().from(s.destinos).where(eq(s.destinos.id, t.destino));
	return d ?? null;
}

/* Los hechos de un destino (§4.3): en hechos.ts, para que colocacion.ts los use sin dar la vuelta. */
export { hechosDe, type SensorDeHechos };

/*
 * Inserta el destino con el primer id libre a partir de base (un slug). Con
 * «on conflict (id)», y no con una consulta antes, para que dos altas a la
 * vez no se pisen; la del sensor (un destino por sensor) sí falla.
 */
export async function insertarDestino(
	tx: Tx,
	v: {
		base: string;
		nombre: string;
		tipo: TipoDestino;
		sensor?: string;
		descripcion?: DescripcionDestino;
	}
) {
	const { base, ...fila } = v;
	for (let n = 1; n <= CANDIDATOS; n++) {
		const [f] = await tx
			.insert(s.destinos)
			.values({ id: idDestino(base, n), ...fila })
			.onConflictDoNothing({ target: s.destinos.id })
			.returning({ id: s.destinos.id });
		if (f) return f.id;
	}
	throw new Error(`No queda ningún id libre a partir de «${base}».`);
}

/* Un destino descrito a mano, sin sensor. Devuelve su id. */
export async function crearDestino(
	quien: string,
	v: { nombre: string; tipo: TipoDestino; descripcion?: DescripcionDestino }
) {
	return db.transaction(async (tx) => {
		const id = await insertarDestino(tx, { base: slugDestino(v.nombre), ...v });
		await tx.insert(s.auditoria).values({ quien, accion: 'destino creado', detalle: { id, ...v } });
		return id;
	});
}

/* Un sensor que no late en este tiempo se da por caído: el mismo plazo que en Sensores. */
const LATIDO_MAXIMO = 5 * 60_000;
const vivo = (ultimo: Date | null, ahora: number) =>
	!!ultimo && ahora - ultimo.getTime() < LATIDO_MAXIMO;

/* Los ejecutores que conoce esta consola (§6.1): en catalogo.ts, que no importa este fichero. */
export { EJECUTORES_CONSOLA };

/*
 * Un destino tal como lo ve el elector (§7.1), de su fila y la de su sensor
 * (o null): su agente, con la versión que dijo y si late, y sus hechos.
 */
export function destinoDelElector(
	d: typeof s.destinos.$inferSelect,
	x: typeof s.sensores.$inferSelect | null,
	ahora = Date.now()
): Destino {
	return {
		id: d.id,
		nombre: d.nombre,
		tipo: d.tipo as TipoDestino,
		activo: d.activo,
		agente: x
			? {
					sensor: x.id,
					...(x.versionAgente ? { version: x.versionAgente } : {}),
					vivo: vivo(x.ultimoLatido, ahora)
				}
			: null,
		hechos: hechosDe(d, x)
	};
}

/* Como el nombre de una trampa: lo bastante corto para una lista y para el comentario de un script. */
const LARGO_NOMBRE = 100;
const LARGO_NOTA = 500;
/*
 * Saltos de línea, caracteres de control y de formato (los que invierten la
 * dirección del texto, los de anchura cero): el nombre de un destino acaba en
 * el comentario de los pasos manuales, y renderizar los rechazaría (§6.3).
 */
const INVISIBLES = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/* Una IP (v4 o v6) o un nombre de máquina; sin espacios. */
const DIRECCION = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
/* Una versión con puntos, como la comparan los requisitos: 22.04, 14.5, 6.1.0. */
const VERSION = /^\d{1,6}(\.\d{1,9}){0,3}$/;

export interface FormularioLeido {
	nombre: string;
	descripcion: DescripcionDestino;
	errores: string[];
}

/*
 * Las respuestas del formulario corto de un destino de ese tipo (§5.2),
 * comprobadas una a una; lo que no es de su tipo, o de su sistema, no se lee.
 * bloqueados: los campos que ya dice el sensor del destino, que no se leen (se
 * quedan como estaban, editarDestino), y so el sistema que dice, para saber
 * qué shell y qué versiones valen.
 */
export function leerFormulario(
	f: FormData,
	tipo: string,
	sensor: { bloqueados: CampoDestino[]; so?: string } = { bloqueados: [] }
): FormularioLeido {
	const errores: string[] = [];
	const texto = (k: string) => String(f.get(k) ?? '').trim();
	const nombre = texto('nombre');
	if (!nombre) errores.push('Nombre: obligatorio.');
	else if (nombre.length > LARGO_NOMBRE)
		errores.push(`Nombre: como mucho ${LARGO_NOMBRE} caracteres.`);
	else if (INVISIBLES.test(nombre))
		errores.push('Nombre: sin saltos de línea ni caracteres invisibles.');

	const pide = new Set(camposDe(tipo).filter((c) => !sensor.bloqueados.includes(c)));
	/* Una respuesta de una lista cerrada; vacía, si no es obligatoria, es que no se sabe. */
	function deLista<T extends string>(
		k: string,
		opciones: { valor: T }[],
		campo: string,
		obligatorio = false
	): T | undefined {
		const v = texto(k);
		if (!v) {
			if (obligatorio) errores.push(`${campo}: obligatorio.`);
			return undefined;
		}
		const o = opciones.find((x) => x.valor === v);
		if (!o) errores.push(`${campo}: elige una opción de la lista.`);
		return o?.valor;
	}

	const d: DescripcionDestino = {};
	if (pide.has('direccion')) {
		const v = texto('direccion');
		if (v && !DIRECCION.test(v))
			errores.push('Dirección: una IP o un nombre de máquina, sin espacios.');
		else if (v) d.direccion = v;
	}
	if (pide.has('so'))
		d.so = deLista(
			'so',
			sistemasDe(tipo),
			'Sistema operativo',
			tipo === 'maquina' || tipo === 'fileserver'
		);
	const so = sensor.bloqueados.includes('so') ? sensor.so : d.so;
	if (pide.has('edicion')) d.edicion = deLista('edicion', EDICIONES, 'Edición');
	if (pide.has('version')) {
		const v = texto('version');
		if (v && so === 'windows') {
			if (versionesWindows(tipo, d.edicion).some((x) => x.valor === v)) d.version = v;
			else errores.push('Versión: elige una de la lista.');
		} else if (v && !VERSION.test(v))
			errores.push('Versión: números separados por puntos, como 22.04.');
		else if (v) d.version = v;
	}
	if (pide.has('powershell') && so === 'windows')
		d.powershell = deLista('powershell', POWERSHELL, 'PowerShell');
	if (pide.has('posix') && so && so !== 'windows') d.posix = deLista('posix', POSIX, 'Shell');
	if (pide.has('protocolos')) {
		const marcados = new Set(f.getAll('protocolos').map(String));
		const conocidos = PROTOCOLOS.filter((p) => marcados.has(p.valor)).map((p) => p.valor);
		if (conocidos.length < marcados.size) errores.push('Protocolos: elige de la lista.');
		if (conocidos.length) d.protocolos = conocidos;
	}
	if (pide.has('nota')) {
		const v = texto('nota');
		if (v.length > LARGO_NOTA) errores.push(`Descripción: como mucho ${LARGO_NOTA} caracteres.`);
		else if (v) d.nota = v;
	}
	for (const k of Object.keys(d) as CampoDestino[]) if (d[k] === undefined) delete d[k];
	return { nombre, descripcion: d, errores };
}

/* Lo que escribió el cliente, tal cual, para volver a enseñar el formulario con un error. */
export function valoresDeFormulario(f: FormData): Record<string, string | string[]> {
	const v: Record<string, string | string[]> = {};
	for (const k of [
		'nombre',
		'so',
		'edicion',
		'version',
		'powershell',
		'posix',
		'direccion',
		'nota'
	])
		v[k] = String(f.get(k) ?? '');
	v.protocolos = f.getAll('protocolos').map(String);
	return v;
}

/* Lo que se cuenta de un motivo en la página: su código (para soporte), el texto y el remedio. */
export const enTexto = (m: Motivo) => ({
	codigo: m.codigo,
	texto: m.texto,
	...(m.remedio ? { remedio: m.remedio } : {})
});
export type MotivoVisible = ReturnType<typeof enTexto>;

/*
 * Lo que dice el elector de una honeycosa en un destino, para «Qué puedes
 * poner aquí» y para el alta: la vía elegida con sus avisos o, si no vale
 * ninguna, el primer motivo, y cada vía con los suyos para el «por qué».
 */
export function resumenEleccion(h: Honeycosa, e: Eleccion) {
	const evaluadas = new Map([...e.validas, ...e.descartadas].map((v) => [v.via, v]));
	const primero =
		e.global && e.global.codigo !== 'elector.sin-via'
			? e.global
			: (e.descartadas[0]?.motivos[0] ?? e.global);
	return {
		modulo: h.id,
		nombre: h.nombre,
		elegida: e.elegida && {
			via: e.elegida.via,
			ejecutor: e.elegida.ejecutor,
			nombre: e.elegida.nombre,
			avisos: e.elegida.avisos.map(enTexto)
		},
		motivo: e.elegida || !primero ? null : enTexto(primero),
		vias: h.vias.flatMap((v) => {
			const x = evaluadas.get(v.id);
			return x
				? [
						{
							via: x.via,
							ejecutor: x.ejecutor,
							nombre: x.nombre,
							vale: x.motivos.length === 0,
							motivos: x.motivos.map(enTexto),
							avisos: x.avisos.map(enTexto)
						}
					]
				: [];
		})
	};
}

/*
 * Las trampas activas de contenedor con los puertos que publican, por
 * destino: con ellas mira el elector los choques (puertos.otra-trampa). Las
 * de un destino, o las de todos (el paso «¿dónde?» del alta) con una sola
 * consulta; excepto, la que se está modificando. Una trampa de contenedor
 * está en la máquina de su sensor: si una consola anterior la dejó sin
 * destino, cuenta en el de su sensor.
 */
export async function trampasConPuertos(
	catalogo: Map<string, Honeycosa>,
	filtro: { destino?: string; excepto?: string } = {},
	bd: Bd = db
): Promise<Map<string, ContextoElector['trampasDelDestino']>> {
	/* Con su tabla: dentro de la subconsulta, "sensor" a secas sería el de destinos. */
	const destino = sql<
		string | null
	>`coalesce("trampas"."destino", (select d.id from ${s.destinos} d where d.sensor = "trampas"."sensor"))`;
	const filas = await bd
		.select({
			id: s.trampas.id,
			nombre: s.trampas.nombre,
			modulo: s.trampas.modulo,
			via: s.trampas.via,
			parametros: s.trampas.parametros,
			destino
		})
		.from(s.trampas)
		.where(
			and(
				eq(s.trampas.activo, true),
				eq(s.trampas.ejecutor, 'contenedor@1'),
				filtro.destino === undefined ? undefined : sql`${destino} = ${filtro.destino}`,
				filtro.excepto === undefined ? undefined : ne(s.trampas.id, filtro.excepto)
			)
		);
	const r = new Map<string, ContextoElector['trampasDelDestino']>();
	for (const f of filas) {
		const h = catalogo.get(f.modulo);
		const v = h && viaDe(h, f.via);
		const p = v && v.ejecutor === 'contenedor@1' && validarParametros(h.parametros, f.parametros);
		if (!f.destino || !v || !p || !p.ok) continue;
		const puertos = puertosPublicados(v.carga as CargaContenedor, p.valor);
		r.set(f.destino, [...(r.get(f.destino) ?? []), { id: f.id, nombre: f.nombre, puertos }]);
	}
	return r;
}

/*
 * Todas las trampas del cliente por id, para la fuente «trampa» (§2.4): su
 * colocación, su destino con su dirección y las marcas de las que ya apuntan
 * a ella, menos la de excepto (la que se está cambiando: su marca no choca
 * consigo misma).
 */
export async function trampasDelCliente(
	bd: Bd = db,
	excepto?: string
): Promise<Record<string, TrampaDelCliente>> {
	const filas = await bd
		.select({
			trampa: {
				id: s.trampas.id,
				nombre: s.trampas.nombre,
				modulo: s.trampas.modulo,
				colocacion: s.trampas.colocacion,
				sensor: s.trampas.sensor,
				senalTrampa: s.trampas.senalTrampa,
				manual: s.trampas.manual
			},
			destino: s.destinos,
			sensor: s.sensores
		})
		.from(s.trampas)
		.leftJoin(s.destinos, eq(s.destinos.id, s.trampas.destino))
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor));
	const r: Record<string, TrampaDelCliente> = {};
	for (const { trampa: t, destino: d, sensor: x } of filas) {
		const direccion = d ? hechosDe(d, x)['destino.direccion']?.valor : undefined;
		r[t.id] = {
			nombre: t.nombre,
			modulo: t.modulo,
			colocacion: t.colocacion,
			sensor: t.sensor,
			destino: d?.id ?? '',
			destinoNombre: d?.nombre ?? '',
			...(typeof direccion === 'string' ? { direccion } : {}),
			marcas: []
		};
	}
	for (const { trampa: t } of filas)
		if (t.id !== excepto && t.senalTrampa && Object.hasOwn(r, t.senalTrampa) && t.manual?.marca)
			r[t.senalTrampa].marcas.push({ id: t.id, nombre: t.nombre, marca: t.manual.marca });
	return r;
}

/*
 * «Qué puedes poner aquí» (§5.3): cada módulo autorizado con lo que dice el
 * elector en modo sondeo (§7.2), sin parámetros, primero los que valen.
 */
export async function queCabeEn(destino: Destino) {
	const permitidos = new Set(await autorizados());
	const cubre = await coberturaLicencia();
	const catalogo = new Map(honeycosas().map((h) => [h.id, h]));
	const elegibles = [...catalogo.values()].filter(
		(h) => permitidos.has(h.id) && cubre(h.id) === 'cubierta'
	);
	if (!elegibles.length) return [];
	const contexto: ContextoElector = {
		autorizado: true,
		ejecutoresConsola: EJECUTORES_CONSOLA,
		hechosNodo: await hechosNodo(),
		trampasDelDestino:
			(await trampasConPuertos(catalogo, { destino: destino.id })).get(destino.id) ?? [],
		trampas: await trampasDelCliente(),
		nombresModulos: nombresModulos(catalogo.values())
	};
	return elegibles
		.map((h) =>
			resumenEleccion(
				h,
				elegir({ honeycosa: h, destino, parametros: { modo: 'sondeo' }, contexto })
			)
		)
		.sort((a, b) => Number(!!b.elegida) - Number(!!a.elegida));
}

/* Del sensor de un destino, lo que se enseña. */
function sensorVisible(x: typeof s.sensores.$inferSelect, ahora: number) {
	return {
		id: x.id,
		nombre: x.nombre,
		remoto: x.remoto,
		vivo: vivo(x.ultimoLatido, ahora),
		ultimoLatido: x.ultimoLatido?.toISOString() ?? null
	};
}

/* La página Destinos: cada destino con su sensor, su plataforma, sus trampas y sus avisos. */
export async function listaDestinos() {
	const ahora = Date.now();
	const filas = await db
		.select({
			destino: s.destinos,
			sensor: s.sensores,
			/* Con su tabla: en la subconsulta, "id" a secas sería el de trampas. */
			trampas: sql<number>`(select count(*)::int from ${s.trampas} t where t.destino = "destinos"."id")`
		})
		.from(s.destinos)
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor))
		.orderBy(asc(s.destinos.creado), asc(s.destinos.id));
	return filas.map(({ destino: d, sensor: x, trampas }) => ({
		id: d.id,
		nombre: d.nombre,
		tipo: d.tipo,
		activo: d.activo,
		sensor: x && sensorVisible(x, ahora),
		plataforma: plataformaDe(hechosDe(d, x)),
		trampas,
		avisos: avisosSensor(x?.capacidades)
	}));
}

/* Un destino con la fila de su sensor (o null) y sus hechos. null si no existe. */
async function leerDestino(id: string) {
	const [f] = await db
		.select({ destino: s.destinos, sensor: s.sensores })
		.from(s.destinos)
		.leftJoin(s.sensores, eq(s.sensores.id, s.destinos.sensor))
		.where(eq(s.destinos.id, id));
	return f ? { d: f.destino, x: f.sensor, hechos: hechosDe(f.destino, f.sensor) } : null;
}

/* Lo que su sensor ya dice del formulario: los campos que no se editan y el sistema. */
function delSensor(hechos: Hechos) {
	const so = hechos['plataforma.so']?.valor;
	return { bloqueados: camposDelSensor(hechos), so: typeof so === 'string' ? so : undefined };
}

/* Para editar un destino: su tipo y lo que ya dice su sensor. null si no existe. */
export async function edicionDestino(id: string) {
	const f = await leerDestino(id);
	return f && { tipo: f.d.tipo, ...delSensor(f.hechos) };
}

/*
 * La ficha de un destino (§5.3): sus hechos con su fuente, sus trampas, qué
 * se puede poner y lo que hace falta para editarlo (qué dice ya el sensor y
 * qué direcciones sugiere). null si no existe.
 */
export async function fichaDestino(id: string) {
	const f = await leerDestino(id);
	if (!f) return null;
	const { d, x, hechos } = f;
	const sensor = x && sensorVisible(x, Date.now());
	const trampas = await db
		.select({ id: s.trampas.id, nombre: s.trampas.nombre, modulo: s.trampas.modulo })
		.from(s.trampas)
		.where(eq(s.trampas.destino, id))
		.orderBy(asc(s.trampas.creado));
	const estados = trampas.length ? await estadosVisibles() : new Map<string, EstadoVisible>();
	const { bloqueados, so } = delSensor(hechos);
	const direcciones = hechos['red.direcciones']?.valor;
	return {
		id: d.id,
		nombre: d.nombre,
		tipo: d.tipo,
		activo: d.activo,
		descripcion: d.descripcion,
		sensor,
		plataforma: plataformaDe(hechos),
		avisos: avisosSensor(x?.capacidades),
		/* Con su nombre y su valor para el cliente (los dos los da el contrato, como en los motivos). */
		hechos: Object.entries(hechos)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([clave, h]) => ({
				clave,
				...h,
				nombre: Object.hasOwn(NOMBRE_HECHO, clave) ? NOMBRE_HECHO[clave] : null,
				texto: valorVisible(clave, h.valor)
			})),
		/* Con lo que ve el cliente de cada una (§8.2), no lo guardado. */
		trampas: trampas.flatMap((t) => {
			const estado = estados.get(t.id);
			return estado ? [{ ...t, estado }] : [];
		}),
		queCabe: await queCabeEn(destinoDelElector(d, x)),
		formulario: {
			bloqueados,
			delSensor: Object.fromEntries(
				bloqueados.map((c) => [c, valorHecho(hechos[HECHO_DE_CAMPO[c]].valor)])
			) as Partial<Record<CampoDestino, string>>,
			so,
			direcciones: Array.isArray(direcciones) ? direcciones : []
		}
	};
}

/* Las trampas que reciben su señal de una trampa de este destino (senal_trampa, §8.4). */
async function dependientesDe(tx: Tx, destino: string) {
	const deAqui = tx
		.select({ id: s.trampas.id })
		.from(s.trampas)
		.where(eq(s.trampas.destino, destino));
	const filas = await tx
		.select({ nombre: s.trampas.nombre })
		.from(s.trampas)
		.where(inArray(s.trampas.senalTrampa, deAqui))
		.orderBy(asc(s.trampas.nombre));
	return filas.map((x) => x.nombre);
}

/*
 * Editar un destino: su nombre y sus respuestas del formulario. Los campos
 * que ya dice su sensor (bloqueados) no se tocan: se quedan como estaban, y
 * siguen valiendo si un día el sensor deja de decirlos. Cambiar la dirección
 * se niega si una trampa de aquí recibe la señal de otras (§8.4): lo sembrado
 * apunta a la dirección de antes. Devuelve sus nombres, para decir cuáles
 * retirar primero.
 */
export async function editarDestino(
	quien: string,
	id: string,
	v: { nombre: string; descripcion: DescripcionDestino; bloqueados: CampoDestino[] }
): Promise<'editado' | 'no-existe' | { dependientes: string[] }> {
	return db.transaction(async (tx) => {
		const [d] = await tx.select().from(s.destinos).where(eq(s.destinos.id, id)).for('update');
		if (!d) return 'no-existe';
		const antes: DescripcionDestino = d.descripcion ?? {};
		const descripcion: Record<string, unknown> = { ...v.descripcion };
		for (const c of v.bloqueados)
			if (Object.hasOwn(antes, c)) descripcion[c] = antes[c];
			else delete descripcion[c];
		if ((antes.direccion ?? '') !== ((descripcion.direccion as string | undefined) ?? '')) {
			const dependientes = await dependientesDe(tx, id);
			if (dependientes.length) return { dependientes };
		}
		await tx
			.update(s.destinos)
			.set({ nombre: v.nombre, descripcion: descripcion as DescripcionDestino })
			.where(eq(s.destinos.id, id));
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'destino modificado',
			detalle: {
				id,
				nombre: v.nombre,
				descripcion,
				antes: { nombre: d.nombre, descripcion: antes }
			}
		});
		return 'editado';
	});
}

/*
 * Dar de baja un destino lo borra (§5.3). No se da de baja uno con trampas
 * (primero se retiran, como con los sensores) ni uno con sensor, que se da de
 * baja retirando su sensor. Bloqueado: una trampa que entrara a la vez
 * esperaría y fallaría por su clave foránea.
 */
export async function darDeBajaDestino(
	quien: string,
	id: string
): Promise<'borrado' | 'no-existe' | 'tiene sensor' | 'tiene trampas'> {
	return db.transaction(async (tx) => {
		const [d] = await tx.select().from(s.destinos).where(eq(s.destinos.id, id)).for('update');
		if (!d) return 'no-existe';
		if (d.sensor) return 'tiene sensor';
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(s.trampas)
			.where(eq(s.trampas.destino, id));
		if (n > 0) return 'tiene trampas';
		await tx.delete(s.destinos).where(eq(s.destinos.id, id));
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'destino dado de baja',
			detalle: { id, nombre: d.nombre, tipo: d.tipo }
		});
		return 'borrado';
	});
}
