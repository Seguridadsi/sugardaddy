/*
 * «Probar» una trampa (docs/diseno/modulo-despliegue.md §8.3). Quien despliega
 * abre una ventana de unos minutos y sigue unos pasos que provocan un evento:
 * los que trae la vía, una conexión a un puerto TCP de la trampa si la vía no
 * trae ninguno, o, si la señal es otra trampa, un script que se ejecuta en el
 * propio destino de lo sembrado. Un evento recibido (reloj de la consola)
 * dentro de la ventana más 2 minutos, que cumpla la marca de la prueba o, si
 * no tiene, venga de una de sus IPs, es de prueba: comprueba la trampa y se
 * ve como los demás, con su etiqueta, pero no pasa al motor de respuesta, no
 * da alerta y no se comparte como indicador.
 *
 * Lo que mira la entrega de eventos (pruebasAbiertas, pruebasDe y
 * anotarPrueba) no lee el catálogo: la marca se guarda ya rellena al abrir
 * la prueba.
 */
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
	EJECUTORES,
	bloqueDeVariables,
	cumpleMarca,
	formatosDe,
	probar,
	pruebaDeVia,
	puertosPublicados,
	validarParametros,
	variablesDeVia,
	viaDe
} from '@sugardaddy/contrato';
import type {
	CargaContenedor,
	Evento,
	FormatoPasos,
	Honeycosa,
	LenguajeManual,
	Marca,
	PasoGenerado,
	PruebaDeVia,
	Via
} from '@sugardaddy/contrato';
import { honeycosas } from './catalogo';
import {
	comprobarConEvento,
	estadosVisibles,
	type EstadoVisible,
	type FilaColocacion
} from './colocacion';
import { db, schema as s } from './db';
import { destinoDeTrampa, type Tx } from './destinos';
import { hechosDe } from './hechos';
import { marcaDeToque } from './toques';

/* Tras «hasta» aún cuenta lo que estaba de camino: 2 minutos (§8.3). */
export const MARGEN_MS = 2 * 60_000;
/* La ventana de la prueba genérica, y de una vía que no dice la suya. */
const VENTANA_POR_DEFECTO = 15;
/* Las que se pueden probar: puestas (también degradadas, que pueden seguir recibiendo). */
const PROBABLES: readonly EstadoVisible['estado'][] = ['colocada', 'comprobada', 'degradada'];
/* La dirección de un destino, tal como la admite su formulario: se puede enseñar en una orden. */
const DIRECCION = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;

const ALFABETO = 'abcdefghijklmnopqrstuvwxyz0123456789';

/* 8 caracteres [a-z0-9] al azar (crypto): lo que hace única cada prueba. */
export function nuevoNonce(): string {
	let n = '';
	for (let i = 0; i < 8; i++) n += ALFABETO[randomInt(ALFABETO.length)];
	return n;
}

/*
 * Una IP escrita como la escribe el sensor: en minúsculas, sin corchetes, una
 * IPv4 dentro de IPv6 (::ffff:10.0.0.5, como la da un servidor de doble pila)
 * como IPv4 y una IPv6 abreviada. null si no es una IP.
 */
export function normalizarIp(ip: string | null | undefined): string | null {
	if (!ip) return null;
	let t = ip
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, '$1');
	t = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t)?.[1] ?? t;
	const v = isIP(t);
	if (v === 4) return t;
	if (v === 6) return new URL(`http://[${t}]`).hostname.slice(1, -1);
	return null;
}

/* Una IPv4 como número, o null si no lo es. */
function ipv4(ip: string): number | null {
	const p = ip.split('.');
	if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
	return p.reduce((n, x) => n * 256 + Number(x), 0);
}

/* Si una IPv4 cae en una red en CIDR IPv4 (la de un sensor: 10.70.0.0/24). */
function enRed(ip: string, red: string): boolean {
	const [base, bits] = red.split('/');
	const a = ipv4(ip);
	const b = ipv4(base ?? '');
	const n = Number(bits);
	if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
	const tramo = 2 ** (32 - n);
	return Math.floor(a / tramo) === Math.floor(b / tramo);
}

/*
 * La IP de la máquina de un sensor, de las que cuenta él mismo (hecho
 * red.direcciones): la que cae en su red, si se sabe, y si no la primera.
 * null si no cuenta ninguna (un sensor anterior a la 0.17.1). Pura.
 */
export function ipDeLaMaquina(direcciones: unknown, red: string | null): string | null {
	const ips = Array.isArray(direcciones)
		? direcciones.filter((x): x is string => typeof x === 'string' && isIP(x) !== 0)
		: [];
	return (red ? ips.find((x) => enRed(x, red)) : undefined) ?? ips[0] ?? null;
}

/* ---------------------------------------------------------------------------
 * Qué da «Probar» en una trampa
 * ------------------------------------------------------------------------- */

export type FormaPrueba = 'via' | 'generica' | 'destino';

export type ComoProbar =
	| { puede: false; motivo: string; destino?: string }
	| {
			puede: true;
			/*
			 * via: los pasos de su vía (contenedor@1); generica: conectarse a un
			 * puerto TCP suyo; destino: el script de prueba de su vía manual@1, que
			 * se ejecuta en el destino de lo sembrado.
			 */
			forma: FormaPrueba;
			/*
			 * Sin marca, cuenta por la IP: la que diga quien prueba (por defecto, la
			 * del navegador) o, si se prueba desde el destino, la de ese destino.
			 */
			porIp: 'pedir' | 'destino' | null;
			ip: string | null;
			ventanaMin: number;
	  };

/* El destino de una trampa, como lo necesita la prueba. */
export type DestinoDePrueba = { id: string; nombre: string; direccion: string | null };

type Trampa = typeof s.trampas.$inferSelect;

/* La prueba genérica (§8.3): el primer puerto TCP que publica la trampa con sus ajustes. */
function puertoTcp(via: Via, parametros: Record<string, unknown>): number | null {
	const carga = via.carga as Partial<CargaContenedor>;
	if (!carga.contenedor) return null;
	return (
		puertosPublicados({ contenedor: carga.contenedor }, parametros).find(
			(x) => x.protocolo === 'tcp'
		)?.puerto ?? null
	);
}

const sinDireccion = (d: DestinoDePrueba) => ({
	puede: false as const,
	motivo: `Pon la dirección de ${d.nombre} en Destinos para probarla.`,
	destino: d.id
});

/*
 * Qué daría «Probar» ahora en una trampa (§8.3), o por qué no se puede: está
 * puesta, su módulo y su vía siguen ahí y hay con qué saber que el evento es
 * de la prueba (una marca o una IP). Pura: recibe lo ya leído. parametros: los
 * de la trampa con los valores por defecto de su módulo.
 */
export function comoProbar(
	t: Pick<Trampa, 'ejecutor' | 'via' | 'manual' | 'senalTrampa'>,
	estado: EstadoVisible | null,
	h: Honeycosa | undefined,
	parametros: Record<string, unknown>,
	d: DestinoDePrueba
): ComoProbar {
	const manual = EJECUTORES[t.ejecutor]?.corre === 'consola';
	if (!estado || !PROBABLES.includes(estado.estado)) {
		const motivo =
			estado?.estado === 'retirando'
				? 'Se está retirando: ya no se prueba.'
				: estado?.estado === 'parada'
					? 'Está parada: reanúdala para probarla.'
					: estado?.estado === 'sin-contacto'
						? 'Su sensor no contesta: la prueba no llegaría. Pruébala cuando vuelva a contestar.'
						: manual
							? 'Primero ponla con sus pasos y pulsa «Ya está hecho».'
							: 'Aún no está puesta: podrás probarla cuando su sensor la ponga.';
		return { puede: false, motivo };
	}
	if (manual) {
		const p = t.manual;
		if (!p) return { puede: false, motivo: 'No tiene pasos guardados: no se puede probar.' };
		if (!p.marca || !t.senalTrampa)
			return {
				puede: false,
				motivo: 'Su señal aún no puede llegar a la consola: no se puede probar.'
			};
		if (!p.prueba)
			return {
				puede: false,
				motivo:
					'Su forma no trae prueba: quedará comprobada con el primer evento real que llegue por su señal.'
			};
		if (p.prueba.marca)
			return {
				puede: true,
				forma: 'destino',
				porIp: null,
				ip: null,
				ventanaMin: p.prueba.ventanaMin
			};
		/* Sin marca, cuenta lo que llegue desde el propio destino: hace falta su IP. */
		if (!d.direccion) return sinDireccion(d);
		const ip = normalizarIp(d.direccion);
		if (!ip)
			return {
				puede: false,
				motivo: `Para probarla hace falta la IP de ${d.nombre}, no su nombre: ponla en Destinos.`,
				destino: d.id
			};
		return { puede: true, forma: 'destino', porIp: 'destino', ip, ventanaMin: p.prueba.ventanaMin };
	}
	if (!h)
		return { puede: false, motivo: 'Su módulo ya no está en el catálogo: no se puede probar.' };
	const via = viaDe(h, t.via);
	if (!via || via.ejecutor !== t.ejecutor)
		return {
			puede: false,
			motivo: 'La forma con que se puso ya no existe en su módulo: no se puede probar.'
		};
	const prueba = via.comprobacion?.prueba;
	if (prueba) {
		const usaDireccion = variablesDeVia(via, h.parametros).usos.some(
			(u) => u.prueba && u.variable.de === 'contexto' && u.variable.nombre === 'destino.direccion'
		);
		if (usaDireccion && !d.direccion) return sinDireccion(d);
		return {
			puede: true,
			forma: 'via',
			porIp: prueba.marca ? null : 'pedir',
			ip: null,
			ventanaMin: prueba.ventanaMin ?? VENTANA_POR_DEFECTO
		};
	}
	if (puertoTcp(via, parametros) === null)
		return {
			puede: false,
			motivo:
				'No trae prueba y no escucha en ningún puerto TCP: quedará comprobada con el primer evento real que llegue.'
		};
	if (!d.direccion || !DIRECCION.test(d.direccion)) return sinDireccion(d);
	return {
		puede: true,
		forma: 'generica',
		porIp: 'pedir',
		ip: null,
		ventanaMin: VENTANA_POR_DEFECTO
	};
}

/* ---------------------------------------------------------------------------
 * Con la base de datos: abrir una prueba y enseñarla
 * ------------------------------------------------------------------------- */

/*
 * Lo que hace falta de una trampa para su prueba: su módulo, sus ajustes y su
 * destino. La dirección del destino es la que se puso en Destinos; si no se
 * puso y el destino es la máquina de un sensor, la IP que ese sensor cuenta de
 * ella (red.direcciones), que es donde publica sus trampas. Sin esto, el
 * destino del sensor del nodo, que el instalador crea sin dirección, no se
 * podía probar: ni «Probar» ni «Prueba mi detección» tocaban nada.
 */
async function datosDe(t: Trampa) {
	const h = honeycosas().find((x) => x.id === t.modulo);
	const p = h ? validarParametros(h.parametros, t.parametros) : null;
	const parametros = p?.ok ? p.valor : t.parametros;
	const fila = await destinoDeTrampa(t);
	let direccion: string | null = null;
	if (fila) {
		const sensor = fila.sensor
			? ((await db.select().from(s.sensores).where(eq(s.sensores.id, fila.sensor)))[0] ?? null)
			: null;
		const hechos = hechosDe(fila, sensor);
		const v = hechos['destino.direccion']?.valor;
		if (typeof v === 'string') direccion = v;
		else if (sensor) direccion = ipDeLaMaquina(hechos['red.direcciones']?.valor, sensor.red);
	}
	const destino: DestinoDePrueba = {
		id: fila?.id ?? t.sensor,
		nombre: fila?.nombre ?? t.sensor,
		direccion
	};
	return { h, parametros, destino };
}

/*
 * Lo que necesita «Prueba mi detección» (prueba-deteccion.ts) para tocar una
 * trampa desde el nodo: cómo se probaría (comoProbar) y, si es la genérica,
 * su objetivo —su dirección y el primer puerto TCP que publica—, el mismo que
 * enseña «Probar» en su ficha. objetivo es null si no es una trampa genérica
 * con puerto TCP y una dirección conocida (las de vía o destino se prueban con
 * sus pasos, no con un toque). Lee lo de la trampa una sola vez.
 */
export async function toqueDeTrampa(
	t: Trampa,
	estado: EstadoVisible | null
): Promise<{ como: ComoProbar; objetivo: { direccion: string; puerto: number } | null }> {
	const { h, parametros, destino } = await datosDe(t);
	const como = comoProbar(t, estado, h, parametros, destino);
	if (!como.puede || como.forma !== 'generica') return { como, objetivo: null };
	const via = h && viaDe(h, t.via);
	const puerto = via ? puertoTcp(via, parametros) : null;
	if (puerto === null || !destino.direccion || !DIRECCION.test(destino.direccion))
		return { como, objetivo: null };
	return { como, objetivo: { direccion: destino.direccion, puerto } };
}

/* Los pasos de una prueba ya rellenos, para enseñarlos. null si ya no se pueden preparar. */
type PasosDePrueba =
	| {
			forma: 'destino';
			pasos: PasoGenerado[];
			lenguaje: LenguajeManual;
			bloque: string;
			formatos: FormatoPasos[];
	  }
	| { forma: 'via'; pasos: PasoGenerado[]; variables: [string, string][] }
	| { forma: 'generica'; direccion: string; puerto: number; windows: string; linux: string };

function pasosDePrueba(
	t: Trampa,
	h: Honeycosa | undefined,
	parametros: Record<string, unknown>,
	d: DestinoDePrueba,
	forma: FormaPrueba,
	nonce: string
): { pasos: PasosDePrueba; marca: Marca | null } | { error: string } {
	if (forma === 'destino') {
		const p = t.manual;
		if (!p?.prueba) return { error: 'Su forma no trae prueba.' };
		const r = probar(p, nonce);
		return {
			pasos: {
				forma,
				pasos: r.pasos,
				lenguaje: p.lenguaje,
				bloque: bloqueDeVariables({ lenguaje: p.lenguaje, variables: { ...p.variables, nonce } }),
				formatos: formatosDe(p)
			},
			marca: r.marca ?? null
		};
	}
	const via = h && viaDe(h, t.via);
	if (!h || !via) return { error: 'La forma con que se puso ya no existe en su módulo.' };
	if (forma === 'via') {
		const r = pruebaDeVia(
			h,
			via.id,
			parametros,
			{
				trampa: { id: t.id, nombre: t.nombre },
				destino: { id: d.id, nombre: d.nombre, ...(d.direccion ? { direccion: d.direccion } : {}) },
				trampas: {}
			},
			nonce
		);
		if (!r) return { error: 'Su forma no trae prueba.' };
		if (!r.ok) return { error: r.errores.join('; ') };
		return {
			pasos: { forma, pasos: r.valor.pasos, variables: conOrdenes(r.valor) },
			marca: r.valor.marca ?? null
		};
	}
	const puerto = puertoTcp(via, parametros);
	if (puerto === null || !d.direccion || !DIRECCION.test(d.direccion))
		return { error: 'Ya no tiene un puerto TCP o su destino ya no tiene dirección.' };
	return {
		pasos: {
			forma,
			direccion: d.direccion,
			puerto,
			windows: `Test-NetConnection -ComputerName ${d.direccion} -Port ${puerto}`,
			linux: `nc -vz ${d.direccion} ${puerto}`
		},
		marca: null
	};
}

/* Con órdenes en sus pasos (sin lenguaje, en una contenedor@1), los valores que usan, para enseñarlos. */
const conOrdenes = (p: PruebaDeVia): [string, string][] =>
	p.pasos.some((x) => x.orden !== undefined || x.comprobar !== undefined)
		? Object.entries(p.variables)
		: [];

/* Abierta, con su id; o por qué no. */
export type AbrirPrueba = { abierta: string; nonce: string } | 'no-existe' | { error: string };

/*
 * «Probar» (§8.3): abre una prueba de la trampa con un nonce nuevo y su
 * ventana, con la marca ya rellena o las IPs de las que tiene que venir el
 * evento. ip: la que dice quien prueba, si la prueba no tiene marca (por
 * defecto, la de su navegador), o varias: las que puede llevar el toque de
 * «Prueba mi detección», que sale del nodo por el NAT de Docker. Queda en la
 * auditoría: es una persona quien decide que unos eventos no pasen al motor
 * de respuesta.
 *
 * opciones: la ventana, si no es la de su forma (el toque llega en segundos:
 * no hace falta dejar abiertos 15 minutos en los que lo que llegue de esas IPs
 * no avisaría), y los estados visibles ya leídos, para no volver a leerlos por
 * cada trampa al probar muchas a la vez.
 */
export async function abrirPrueba(
	quien: string,
	id: string,
	ip: string | readonly string[] | null,
	opciones: {
		ventanaMin?: number;
		estados?: Map<string, EstadoVisible>;
		/* La toca el sensor, que marca su evento con el nonce: no hacen falta IPs. */
		porToque?: boolean;
	} = {}
): Promise<AbrirPrueba> {
	const [t] = await db.select().from(s.trampas).where(eq(s.trampas.id, id));
	if (!t) return 'no-existe';
	const { h, parametros, destino } = await datosDe(t);
	const estado = (opciones.estados ?? (await estadosVisibles())).get(t.id) ?? null;
	const como = comoProbar(t, estado, h, parametros, destino);
	if (!como.puede) return { error: como.motivo };
	let esperadas = como.ip ? [como.ip] : [];
	if (como.porIp === 'pedir' && !opciones.porToque) {
		const dichas = typeof ip === 'string' ? [ip] : (ip ?? []);
		esperadas = [...new Set(dichas.map(normalizarIp).filter((x) => x !== null))];
		if (!esperadas.length)
			return {
				error:
					'Escribe la IP del equipo desde el que vas a probar (por ejemplo, 10.0.0.25): es como la consola sabrá qué evento es de la prueba.'
			};
	}
	const nonce = nuevoNonce();
	const r = pasosDePrueba(t, h, parametros, destino, como.forma, nonce);
	if ('error' in r) return { error: `No se puede preparar su prueba: ${r.error}` };
	const ventanaMin = opciones.ventanaMin ?? como.ventanaMin;
	const marca = opciones.porToque ? marcaDeToque(nonce) : r.marca;
	const abierta = await db.transaction(async (tx) => {
		const [p] = await tx
			.insert(s.pruebas)
			.values({
				trampa: t.id,
				nonce,
				ip: marca ? null : (esperadas[0] ?? null),
				ips: marca ? null : esperadas,
				marca,
				hasta: sql`now() + ${ventanaMin} * interval '1 minute'`,
				quien
			})
			.returning({ id: s.pruebas.id, hasta: s.pruebas.hasta });
		await tx.insert(s.auditoria).values({
			quien,
			accion: 'prueba abierta',
			detalle: {
				id: t.id,
				prueba: p.id,
				hasta: p.hasta.toISOString(),
				...(marca ? { marca } : { ips: esperadas })
			}
		});
		return p.id;
	});
	return { abierta, nonce };
}

/* Las IPs de una prueba; la de «ip» si la abrió una consola anterior a «ips». */
const ipsDe = (p: { ip: string | null; ips: string[] | null }): string[] =>
	p.ips ?? (p.ip ? [p.ip] : []);

export type PruebaVista = {
	id: string;
	/* esperando: dentro de la ventana (más el margen) y sin evento; recibida: ya llegó uno. */
	estado: 'esperando' | 'recibida' | 'caducada';
	desde: string;
	hasta: string;
	/* Sin marca: las IPs de las que tiene que venir. */
	ips: string[];
	conMarca: boolean;
	evento: { recibido: string; ip: string | null } | null;
	pasos: PasosDePrueba | null;
};

/*
 * Lo que enseña la ficha de una trampa sobre «Probar»: si se puede y cómo, y
 * la última prueba con sus pasos rellenos (con su nonce) y si ya llegó su
 * evento.
 */
export async function pruebaDeTrampa(
	t: Trampa,
	estado: EstadoVisible | null,
	ahora = Date.now()
): Promise<{ como: ComoProbar; ultima: PruebaVista | null }> {
	const { h, parametros, destino } = await datosDe(t);
	const como = comoProbar(t, estado, h, parametros, destino);
	const [p] = await db
		.select()
		.from(s.pruebas)
		.where(eq(s.pruebas.trampa, t.id))
		.orderBy(desc(s.pruebas.desde))
		.limit(1);
	if (!p) return { como, ultima: null };
	const [e] = p.evento
		? await db
				.select({ recibido: s.eventos.recibido, ip: s.eventos.ip })
				.from(s.eventos)
				.where(eq(s.eventos.id, p.evento))
		: [];
	const forma: FormaPrueba =
		EJECUTORES[t.ejecutor]?.corre === 'consola'
			? 'destino'
			: h && viaDe(h, t.via)?.comprobacion?.prueba
				? 'via'
				: 'generica';
	const r = pasosDePrueba(t, h, parametros, destino, forma, p.nonce);
	return {
		como,
		ultima: {
			id: p.id,
			estado: p.evento
				? 'recibida'
				: ahora <= p.hasta.getTime() + MARGEN_MS
					? 'esperando'
					: 'caducada',
			desde: p.desde.toISOString(),
			hasta: p.hasta.toISOString(),
			ips: ipsDe(p),
			conMarca: p.marca !== null,
			evento: e ? { recibido: e.recibido.toISOString(), ip: e.ip } : null,
			pasos: 'error' in r ? null : r.pasos
		}
	};
}

/* El nonce de la prueba abierta de una trampa, para descargar su script; null si no hay. */
export async function nonceAbierto(id: string): Promise<string | null> {
	/* El guion de ?parte=probar solo sale con la ventana VIVA: si la prueba
	 * ya disparó (nonce_usado marcado en su baliza), el código está gastado y
	 * ejecutarlo sería señal real, no prueba. Las trampas sin baliza no
	 * tienen ventana que gastar y quedan como estaban. */
	const [p] = await db
		.select({ nonce: s.pruebas.nonce })
		.from(s.pruebas)
		.leftJoin(s.balizas, eq(s.balizas.trampa, s.pruebas.trampa))
		.where(
			and(
				eq(s.pruebas.trampa, id),
				sql`${s.pruebas.hasta} >= now() - ${MARGEN_MS / 1000} * interval '1 second'`,
				isNull(s.balizas.nonceUsado)
			)
		)
		.orderBy(desc(s.pruebas.desde))
		.limit(1);
	return p?.nonce ?? null;
}

/* ---------------------------------------------------------------------------
 * En la entrega de eventos
 * ------------------------------------------------------------------------- */

/* Una prueba abierta, con lo que hace falta para saber si un evento es suyo. */
export type PruebaAbierta = {
	id: string;
	trampa: string;
	/* De qué trampa son los eventos que cuentan: la propia o, si su señal es otra, esa (o ninguna). */
	de: string | null;
	/* Si su señal es otra trampa, la marca con que se reconoce lo sembrado: el evento tiene que activarla. */
	senal: Marca | null;
	marca: Marca | null;
	/* Sin marca: las IPs de las que tiene que venir su evento. */
	ips: string[];
	desde: Date;
	hasta: Date;
	evento: string | null;
};

/*
 * Las pruebas que siguen abiertas (con el margen) de las trampas de un
 * sensor: las suyas y las manuales cuya señal recibe. Una consulta por
 * entrega, por el índice de las trampas del sensor.
 */
export async function pruebasAbiertas(tx: Tx, sensor: string): Promise<PruebaAbierta[]> {
	const filas = await tx
		.select({
			id: s.pruebas.id,
			trampa: s.pruebas.trampa,
			marca: s.pruebas.marca,
			ip: s.pruebas.ip,
			ips: s.pruebas.ips,
			desde: s.pruebas.desde,
			hasta: s.pruebas.hasta,
			evento: s.pruebas.evento,
			senalTrampa: s.trampas.senalTrampa,
			senal: sql<Marca | null>`${s.trampas.manual} -> 'marca'`
		})
		.from(s.pruebas)
		.innerJoin(s.trampas, eq(s.trampas.id, s.pruebas.trampa))
		.where(
			and(
				eq(s.trampas.sensor, sensor),
				sql`${s.pruebas.hasta} >= now() - ${MARGEN_MS / 1000} * interval '1 second'`
			)
		);
	return filas.map(({ senalTrampa, senal, ip, ips, ...p }) => {
		const porOtra = senalTrampa !== null || (senal !== null && typeof senal === 'object');
		return {
			...p,
			ips: ipsDe({ ip, ips }),
			de: porOtra ? senalTrampa : p.trampa,
			senal: porOtra && senal && typeof senal === 'object' ? senal : null
		};
	});
}

/*
 * Las pruebas de las que es un evento recibido a esa hora (§8.3): de su
 * trampa (o de la que recibe su señal, si la activa), dentro de la ventana
 * más el margen, y con la marca de la prueba o, si no tiene, desde una de sus
 * IPs. Pura.
 */
export function pruebasDe(e: Evento, recibido: Date, abiertas: PruebaAbierta[]): PruebaAbierta[] {
	const cuando = recibido.getTime();
	const ip = normalizarIp(e.origen?.ip);
	return abiertas.filter(
		(p) =>
			p.de === e.trampa.id &&
			(p.de === p.trampa || (p.senal !== null && cumpleMarca(e, p.senal))) &&
			cuando >= p.desde.getTime() &&
			cuando <= p.hasta.getTime() + MARGEN_MS &&
			(p.marca ? cumpleMarca(e, p.marca) : ip !== null && p.ips.some((x) => normalizarIp(x) === ip))
	);
}

/*
 * Un evento de prueba ya guardado (con prueba = true): es el de cada prueba
 * que aún no tenía, y comprueba la trampa probada si no es la suya (la que
 * recibe la señal de otra). colocacion: lo leído de cada trampa al empezar la
 * entrega, que se actualiza aquí.
 */
export async function anotarPrueba(
	tx: Tx,
	evento: string,
	pruebas: PruebaAbierta[],
	recibido: Date,
	colocacion: Map<string, FilaColocacion>,
	propia: string
) {
	for (const p of pruebas) {
		if (p.evento === null) {
			await tx
				.update(s.pruebas)
				.set({ evento })
				.where(and(eq(s.pruebas.id, p.id), sql`${s.pruebas.evento} IS NULL`));
			p.evento = evento;
		}
		const f = colocacion.get(p.trampa);
		if (p.trampa !== propia && f && !f.comprobada) {
			const cambio = await comprobarConEvento(tx, p.trampa, f, recibido);
			colocacion.set(p.trampa, { ...f, ...cambio });
		}
	}
}
