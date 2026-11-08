/*
 * El lado del nodo de la inteligencia compartida. Qué puede salir lo dicen
 * las reglas de @sugardaddy/canal (esIpPublica); aquí además se quita lo que
 * el cliente tiene en su lista blanca: eso no se comparte nunca.
 */
import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
	contenidaEn,
	rango,
	restar,
	esIpPublica,
	verificarLista,
	type IndicadorSubida,
	type ListaFirmada
} from '@sugardaddy/canal';
import { db, schema as s } from './db';
import { listaTor, usoTor } from './tor';
import { auditar } from './consultas';
import { operador } from './operador';
import { cubreDominio } from './dominios';
import { migrados } from './origenes-comun';

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

/* Lo que se subiría ahora: agrupado por IP, sin nada más que la IP, el tipo de trampa y el recuento. */
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
	const filas = await db
		.select({
			ip: s.eventos.ip,
			tipo: sql<string>`min(${s.eventos.tipo})`,
			eventos: sql<number>`count(*)::int`,
			primeraVez: sql<Date>`min(${s.eventos.cuando})`
		})
		.from(s.eventos)
		.where(
			and(
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
				ne(s.eventos.accion, 'baliza')
			)
		)
		.groupBy(s.eventos.ip);
	const blanca = await blancas();
	const indicadores: IndicadorSubida[] = filas
		.filter((f) => f.ip && esIpPublica(f.ip) && !contenidaEn(f.ip, blanca))
		.map((f) => ({
			valor: f.ip!,
			clase: 'ip',
			tipo: f.tipo as IndicadorSubida['tipo'],
			primeraVez: new Date(f.primeraVez).toISOString(),
			eventos: f.eventos
		}));
	return { indicadores, hasta };
}

export async function marcarSubidos(hasta: string) {
	const valor: Marca = { hasta };
	await db
		.insert(s.ajustes)
		.values({ clave: 'indicadores', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

/* Sustituye la lista negra global por la recibida, si viene firmada por el panel fijado en el alta. */
export async function aplicarLista(clavePublicaPanel: string, f: ListaFirmada, nodo: string) {
	const v = verificarLista(clavePublicaPanel, f);
	if (!v.ok) {
		await auditar(`node ${nodo}`, 'global list rejected', { motivo: v.motivo });
		return false;
	}
	const quien = await operador();
	await db.transaction(async (tx) => {
		await tx
			.delete(s.listas)
			.where(and(eq(s.listas.ambito, 'global'), eq(s.listas.lista, 'negra')));
		if (v.lista.indicadores.length)
			await tx.insert(s.listas).values(
				v.lista.indicadores.map((i) => ({
					valor: i.valor,
					clase: i.clase,
					lista: 'negra' as const,
					ambito: 'global' as const,
					motivo: i.motivo,
					caduca: new Date(i.caduca),
					quien
				}))
			);
	});
	return true;
}

export async function retirarListaGlobal() {
	await db.delete(s.listas).where(and(eq(s.listas.ambito, 'global'), eq(s.listas.lista, 'negra')));
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
