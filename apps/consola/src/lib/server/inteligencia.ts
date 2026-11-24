/*
 * El lado del nodo de la inteligencia compartida. Qué puede salir lo dicen
 * las reglas de @sugardaddy/canal (esIpPublica); aquí además se quita lo que
 * el cliente tiene en su lista blanca: eso no se comparte nunca.
 */
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import {
	contenidaEn,
	rango,
	restar,
	esIpPublica,
	agentesValidos,
	modulosValidos,
	verificarLista,
	type IndicadorSubida,
	type ListaFirmada,
	type SensorDeIndicador
} from '@sugardaddy/canal';
import { db, schema as s } from './db';
import { agenteCompartido } from '$lib/agente-compartido';
import { listaTor, usoTor } from './tor';
import { auditar } from './consultas';
import { operador } from './operador';
import { cubreDominio } from './dominios';
import { migrados } from './origenes-comun';
import { ipsDelDespliegue } from './ips-propias';
import { diaDe, repartirListaComun, topeDia, topeValido } from './lista-comun-frenos';
import { tecnicasPorIp } from './tecnicas-indicador';
import { geo } from './geo';

type Marca = { hasta: string };

/*
 * Hasta dónde se ha mirado, como texto: con los microsegundos de Postgres. En una
 * fecha de JavaScript se quedarían en milisegundos, y lo último recibido se volvería a
 * subir en cada vuelta. Las marcas de antes, en milisegundos, se leen igual.
 */
async function marca(): Promise<string> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'indicadores'));
	return (f?.valor as Marca | undefined)?.hasta ?? new Date(0).toISOString();
}

/*
 * La lista blanca vigente: se excluye lo caducado igual que hace edl() con las
 * negras. Una entrada blanca con caduca vencida ya no protege (si no, seguiría
 * sacando IPs del EDL y silenciando la compartición para siempre).
 */
async function blancas(ahora = new Date()) {
	const filas = await db
		.select({ id: s.listas.id, valor: s.listas.valor })
		.from(s.listas)
		.where(
			and(eq(s.listas.lista, 'blanca'), or(isNull(s.listas.caduca), gt(s.listas.caduca, ahora)))
		);
	/*
	 * Las IP y redes de la lista blanca pasaron a Orígenes conocidos: cuentan las
	 * de allí (activas y sin caducar, a cualquier hora) y ya no las copiadas.
	 */
	const copiadas = new Set((await migrados())?.listas ?? []);
	const conocidos = await db
		.select({ patron: s.origenesConocidos.patron })
		.from(s.origenesConocidos)
		.where(
			and(
				eq(s.origenesConocidos.activo, true),
				or(isNull(s.origenesConocidos.caduca), gt(s.origenesConocidos.caduca, ahora))
			)
		);
	return [
		...filas.filter((f) => !copiadas.has(f.id)).map((f) => f.valor),
		...conocidos.map((c) => c.patron)
	];
}

/* Lo que se subiría ahora: agrupado por IP, sin nada más que la IP, el tipo y los módulos de trampa, el recuento y el agente de IA reconocido. */
/* Que el evento no esté apartado por el triaje (lo de arriba en indicadoresPendientes); aparte para probarlo. */
export const noApartadoDeInteligencia = () =>
	sql`not exists (select 1 from ${s.triaje} t where t.evento = ${s.eventos.id} and (t.quien in ('modo pentest', 'origen conocido') or (t.estado = 'falso-positivo' and t.via <> 'api')))`;

export async function indicadoresPendientes() {
	const desde = await marca();
	/*
	 * Hasta dónde se ha mirado: todo lo recibido, se suba o no. Si saliera de lo que se
	 * sube, con solo balizas la marca no avanzaría y se volverían a mirar sin fin. Antes
	 * de leer: lo que llegue entre medias se vuelve a mirar en la siguiente, no se pierde.
	 */
	const despuesDe = sql`${s.eventos.recibido} > ${desde}::timestamptz`;
	const [{ ultimo }] = await db
		.select({
			ultimo: sql<
				string | null
			>`to_char(max(${s.eventos.recibido}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
		})
		.from(s.eventos)
		.where(despuesDe);
	const hasta = ultimo ?? desde;
	const subibles = and(
		despuesDe,
		eq(s.eventos.conexionEstablecida, true),
		isNotNull(s.eventos.ip),
		/* Lo que provoca «Probar» viene de un equipo del propio cliente: no es un indicador. */
		eq(s.eventos.prueba, false),
		/*
		 * Ni una baliza: quien abre un cebo fuera de la red puede ser un empleado en su
		 * casa o un escáner, y el relé es público (docs/diseno/rele-balizas.md). Es un
		 * aviso para este cliente, no una IP para repartir a los demás.
		 */
		ne(s.eventos.accion, 'baliza'),
		/*
		 * Ni lo que se apartó por un pentest o un origen conocido, ni lo que alguien
		 * marcó como falso positivo: una empresa de pentest trabaja para varios clientes
		 * y llegaba así al umbral de la lista común, que la bloqueaba en todos. El falso
		 * positivo solo cuenta si lo puso una persona en la consola: uno puesto con un
		 * token de la API (via «api») no saca a nadie de la inteligencia, o un token
		 * robado podría blanquear al atacante para todos los clientes.
		 */
		noApartadoDeInteligencia()
	);
	const filas = await db
		.select({
			ip: s.eventos.ip,
			tipo: sql<string>`min(${s.eventos.tipo})`,
			modulos: sql<string[]>`array_agg(distinct ${s.eventos.modulo})`,
			eventos: sql<number>`count(*)::int`,
			primeraVez: sql<Date>`min(${s.eventos.cuando})`
		})
		.from(s.eventos)
		.where(subibles)
		.groupBy(s.eventos.ip);
	const blanca = await blancas();
	const subir = filas.filter((f) => f.ip && esIpPublica(f.ip) && !contenidaEn(f.ip, blanca));
	const agentes = await agentesPorIp(
		subibles,
		subir.map((f) => f.ip!)
	);
	const tecnicas = await tecnicasPorIp(
		subibles,
		subir.map((f) => f.ip!)
	);
	const sensores = await sensoresPorIp(
		subibles,
		subir.map((f) => f.ip!)
	);
	const indicadores: IndicadorSubida[] = subir.map((f) => ({
		valor: f.ip!,
		clase: 'ip',
		tipo: f.tipo as IndicadorSubida['tipo'],
		modulos: modulosValidos(f.modulos),
		primeraVez: new Date(f.primeraVez).toISOString(),
		eventos: f.eventos,
		/* La consulta solo coge eventos con conexión establecida. */
		conexion: 'tcp' as const,
		...(agentes.get(f.ip!)?.size ? { agentes: agentesValidos([...agentes.get(f.ip!)!]) } : {}),
		...(tecnicas.get(f.ip!)?.length ? { tecnicas: tecnicas.get(f.ip!) } : {}),
		...(sensores.get(f.ip!)?.length ? { sensores: sensores.get(f.ip!) } : {})
	}));
	return { indicadores, hasta };
}

/*
 * En qué país está cada sensor remoto que vio cada IP, para el mapa público del panel
 * (/attack-map), que enseña dónde escucha la red. El país sale de la IP desde la que el
 * sensor llega a esta consola (sensores.direccion), con la base de DB-IP de la imagen: esa
 * IP no sale del nodo, solo el país. El sensor local y los de red privada no tienen país
 * aquí: el panel los pone en el país desde el que llama la consola.
 */
export async function sensoresPorIp(subibles: SQL | undefined, ips: string[]) {
	const por = new Map<string, SensorDeIndicador[]>();
	if (!ips.length) return por;
	const filas = await db
		.select({
			ip: s.eventos.ip,
			direccion: s.sensores.direccion,
			modulo: s.eventos.modulo,
			eventos: sql<number>`count(*)::int`
		})
		.from(s.eventos)
		.innerJoin(s.sensores, eq(s.sensores.id, s.eventos.sensor))
		.where(and(subibles, eq(s.sensores.remoto, true), isNotNull(s.sensores.direccion)))
		.groupBy(s.eventos.ip, s.sensores.direccion, s.eventos.modulo);
	const quiero = new Set(ips);
	const paises = new Map<string, string | null>();
	const acumulado = new Map<string, Map<string, { eventos: number; modulos: Set<string> }>>();
	for (const f of filas) {
		if (!f.ip || !f.direccion || !quiero.has(f.ip)) continue;
		if (!paises.has(f.direccion))
			paises.set(f.direccion, esIpPublica(f.direccion) ? (geo(f.direccion)?.pais ?? null) : null);
		const pais = paises.get(f.direccion);
		if (!pais) continue;
		const deIp = acumulado.get(f.ip) ?? new Map();
		const v = deIp.get(pais) ?? { eventos: 0, modulos: new Set<string>() };
		v.eventos += f.eventos;
		v.modulos.add(f.modulo);
		deIp.set(pais, v);
		acumulado.set(f.ip, deIp);
	}
	for (const [ip, deIp] of acumulado)
		por.set(
			ip,
			[...deIp].map(([pais, v]) => ({
				pais,
				eventos: v.eventos,
				modulos: modulosValidos([...v.modulos])
			}))
		);
	return por;
}

/* Como mucho, cuántos eventos se leen enteros para buscar agentes de IA en una vuelta. */
const MAXIMO_LEIDOS = 20000;

/*
 * Qué agente de IA de ataque se reconoció en cada IP (agente-compartido.ts), leyendo
 * los eventos que se suben. Sale solo el nombre del vocabulario, nunca el evento.
 */
async function agentesPorIp(subibles: SQL | undefined, ips: string[]) {
	const por = new Map<string, Set<string>>();
	if (!ips.length) return por;
	const filas = await db
		.select({ ip: s.eventos.ip, linea: s.eventos.linea })
		.from(s.eventos)
		.where(and(subibles, inArray(s.eventos.ip, ips)))
		.orderBy(desc(s.eventos.recibido))
		.limit(MAXIMO_LEIDOS);
	for (const f of filas) {
		let detalle: unknown;
		try {
			detalle = JSON.parse(f.linea)?.detalle;
		} catch {
			continue;
		}
		const a = agenteCompartido(
			detalle && typeof detalle === 'object' ? (detalle as Record<string, unknown>) : null
		);
		if (!a || !f.ip) continue;
		if (!por.has(f.ip)) por.set(f.ip, new Set());
		por.get(f.ip)!.add(a);
	}
	return por;
}

export async function marcarSubidos(hasta: string) {
	const valor: Marca = { hasta };
	await db
		.insert(s.ajustes)
		.values({ clave: 'indicadores', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

/*
 * Sustituye la lista negra global por la recibida, si viene firmada por el panel fijado en el
 * alta, pero con los frenos del nodo (lista-comun-frenos.ts, docs/diseno/frenos-del-nodo.md):
 * lo que no se puede compartir se descarta, lo que ya estaba se queda y de lo nuevo entran
 * como mucho LISTA_COMUN_TOPE_DIA al día; el resto espera, visible en Lists.
 */
export async function aplicarLista(
	clavesPanel: string | readonly string[],
	f: ListaFirmada,
	nodo: string,
	ahora = new Date(),
	/* Una lista sin `tipo`, de un panel anterior a la 0.32: se acepta y se cuenta (canal.ts). */
	alLegado?: () => Promise<void>
) {
	const v = verificarLista(clavesPanel, f);
	if (!v.ok) {
		await auditar(`node ${nodo}`, 'global list rejected', { motivo: v.motivo });
		return false;
	}
	if (v.legado) await alLegado?.();
	const quien = await operador();
	const intocables = await ipsDelDespliegue();
	const { tope } = await topeListaComun();
	const reparto = await db.transaction(async (tx) => {
		const admitidas = new Set(
			(
				await tx
					.select({ valor: s.listas.valor })
					.from(s.listas)
					.where(and(eq(s.listas.ambito, 'global'), eq(s.listas.lista, 'negra')))
			).map((x) => x.valor)
		);
		const esperaDesde = new Map(
			(await tx.select().from(s.listaComunEspera)).map((x) => [x.valor, x.recibida])
		);
		const dia = diaDe(ahora);
		const [c] = await tx.select().from(s.ajustes).where(eq(s.ajustes.clave, CUPO));
		const previo = c?.valor as Cupo | undefined;
		const usado = previo?.dia === dia && Number.isInteger(previo.n) ? previo.n : 0;
		const r = repartirListaComun({
			entrantes: Array.isArray(v.lista.indicadores) ? v.lista.indicadores : [],
			admitidas,
			esperaDesde,
			cupo: Math.max(0, tope - usado),
			intocables
		});
		await tx
			.delete(s.listas)
			.where(and(eq(s.listas.ambito, 'global'), eq(s.listas.lista, 'negra')));
		const dentro = [...r.mantener, ...r.entrar];
		if (dentro.length)
			await tx.insert(s.listas).values(
				dentro.map((i) => ({
					valor: i.valor,
					clase: 'ip' as const,
					lista: 'negra' as const,
					ambito: 'global' as const,
					motivo: String(i.motivo ?? '').slice(0, 200),
					caduca: new Date(i.caduca),
					quien
				}))
			);
		/* Lo que esperaba y ya no viene en la lista sale de la espera: el panel lo quitó. */
		await tx.delete(s.listaComunEspera);
		if (r.esperar.length)
			await tx.insert(s.listaComunEspera).values(
				r.esperar.map((i) => ({
					valor: i.valor,
					motivo: String(i.motivo ?? '').slice(0, 200),
					caduca: new Date(i.caduca),
					recibida: esperaDesde.get(i.valor) ?? ahora
				}))
			);
		if (r.entrar.length) {
			const valor: Cupo = { dia, n: usado + r.entrar.length };
			await tx
				.insert(s.ajustes)
				.values({ clave: CUPO, valor })
				.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		}
		return r;
	});
	if (reparto.entrar.length || reparto.esperar.length || reparto.rechazadas.length)
		await auditar(`node ${nodo}`, 'global list applied with limits', {
			entran: reparto.entrar.length,
			esperan: reparto.esperar.length,
			descartadas: reparto.rechazadas.length,
			/* Unas pocas, para ver por qué sin llenar la auditoría. */
			ejemplos: reparto.rechazadas.slice(0, 10)
		});
	return true;
}

/* Cuántas IPs nuevas de la lista común han entrado hoy en el EDL. */
const CUPO = 'lista-comun-cupo';
type Cupo = { dia: string; n: number };

/*
 * El tope diario de la lista común. Lo pone el administrador de la consola en Lists, sin
 * desplegar (ajuste `lista-comun-tope`); si no lo ha tocado, el de LISTA_COMUN_TOPE_DIA del
 * .env, y si tampoco, 100. Vive en el nodo y no en el panel a propósito: es el freno contra
 * un panel tomado (docs/diseno/frenos-del-nodo.md), y un panel que pudiera subirlo lo
 * quitaría. Por eso no viaja en el estado deseado.
 */
const TOPE = 'lista-comun-tope';

export async function topeListaComun(): Promise<{ tope: number; propio: boolean }> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, TOPE));
	const n = topeValido((f?.valor as { n?: unknown } | undefined)?.n);
	return n === null
		? { tope: topeDia(env.LISTA_COMUN_TOPE_DIA), propio: false }
		: { tope: n, propio: true };
}

/* Cambia el tope desde Lists. false si no es un entero de 0 a 10.000 o no cambia nada. */
export async function fijarTopeListaComun(quien: string, valor: unknown) {
	const n = topeValido(valor);
	if (n === null) return 'invalido' as const;
	const antes = await topeListaComun();
	if (antes.propio && antes.tope === n) return 'igual' as const;
	await db
		.insert(s.ajustes)
		.values({ clave: TOPE, valor: { n } })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: { n } } });
	await auditar(quien, 'shared list daily limit changed', { antes: antes.tope, tope: n });
	return 'guardado' as const;
}

/* Lo que espera a entrar en el EDL por el tope diario, para Lists. */
export async function listaComunEnEspera() {
	const filas = await db
		.select()
		.from(s.listaComunEspera)
		.orderBy(asc(s.listaComunEspera.recibida), asc(s.listaComunEspera.valor));
	return {
		...(await topeListaComun()),
		entradas: filas.map((x) => ({
			valor: x.valor,
			motivo: x.motivo,
			caduca: x.caduca.toISOString(),
			recibida: x.recibida.toISOString()
		}))
	};
}

export async function retirarListaGlobal() {
	await db.delete(s.listas).where(and(eq(s.listas.ambito, 'global'), eq(s.listas.lista, 'negra')));
	await db.delete(s.listaComunEspera);
}

/*
 * Lo que leen los firewalls: lista negra local y global vigente, en IPs y
 * redes, quitando todo lo que caiga dentro de la lista blanca. La blanca
 * gana siempre: un indicador global no bloquea nunca el controlador de dominio.
 */
export async function edl() {
	const ahora = new Date();
	const negras = await db
		.select({ valor: s.listas.valor, caduca: s.listas.caduca })
		.from(s.listas)
		.where(and(eq(s.listas.lista, 'negra'), inArray(s.listas.clase, ['ip', 'red'])));
	const blanca = await blancas(ahora);
	/* Tor, solo si el cliente lo ha activado. */
	const tor = (await usoTor()).edl ? ((await listaTor())?.ips ?? []) : [];
	/*
	 * Cada IP o red negra menos lo que solape con la blanca: una red negra que
	 * contiene una IP blanca se publica partida, sin ella.
	 */
	const vigentes = negras
		.filter((n) => !n.caduca || n.caduca > ahora)
		.map((n) => n.valor)
		.concat(tor)
		/* Una línea por entrada: lo que no sea una IP o una red no llega a un firewall. */
		.filter((v) => rango(v) !== null)
		.flatMap((v) => restar(v, blanca))
		.filter((v) => !/\s/.test(v));
	return [...new Set(vigentes)].sort();
}

/*
 * Lo que leen los filtros de DNS, proxies web y NGFW: los dominios maliciosos
 * de la lista negra, vigentes, quitando los que tape la lista blanca (por
 * dominio: exacto o subdominio). Igual que edl() pero para la clase «dominio»;
 * los dominios de la negra local NO entran en la inteligencia compartida
 * (indicadoresPendientes solo sube IPs), así que no hay decisión de privacidad.
 */
export async function edlDominios(ahora = new Date()) {
	const negras = await db
		.select({ valor: s.listas.valor, caduca: s.listas.caduca })
		.from(s.listas)
		.where(and(eq(s.listas.lista, 'negra'), eq(s.listas.clase, 'dominio')));
	const blanca = (
		await db
			.select({ valor: s.listas.valor })
			.from(s.listas)
			.where(
				and(
					eq(s.listas.lista, 'blanca'),
					eq(s.listas.clase, 'dominio'),
					or(isNull(s.listas.caduca), gt(s.listas.caduca, ahora))
				)
			)
	).map((b) => b.valor);
	const vigentes = negras
		.filter((n) => !n.caduca || n.caduca > ahora)
		.map((n) => n.valor)
		.filter((d) => !cubreDominio(blanca, d))
		/* Una línea por entrada, como en edl(). */
		.filter((d) => !/\s/.test(d));
	return [...new Set(vigentes)].sort();
}
