/*
 * El lado del nodo de la inteligencia compartida. Qué puede salir lo dicen
 * las reglas de @sugardaddy/canal (esIpPublica); aquí además se quita lo que
 * el cliente tiene en su lista blanca: eso no se comparte nunca.
 */
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import {
	contenidaEn,
	restar,
	esIpPublica,
	verificarLista,
	type IndicadorSubida,
	type ListaFirmada
} from '@sugardaddy/canal';
import { db, schema as s } from './db';
import { listaTor, usoTor } from './tor';
import { auditar } from './consultas';

type Marca = { hasta: string };

async function marca(): Promise<Date> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'indicadores'));
	return new Date((f?.valor as Marca | undefined)?.hasta ?? 0);
}

async function blancas() {
	const filas = await db
		.select({ valor: s.listas.valor })
		.from(s.listas)
		.where(eq(s.listas.lista, 'blanca'));
	return filas.map((f) => f.valor);
}

/* Lo que se subiría ahora: agrupado por IP, sin nada más que la IP, el tipo de trampa y el recuento. */
export async function indicadoresPendientes() {
	const desde = await marca();
	const filas = await db
		.select({
			ip: s.eventos.ip,
			tipo: sql<string>`min(${s.eventos.tipo})`,
			eventos: sql<number>`count(*)::int`,
			primeraVez: sql<Date>`min(${s.eventos.cuando})`,
			hasta: sql<Date>`max(${s.eventos.recibido})`
		})
		.from(s.eventos)
		.where(
			and(
				gt(s.eventos.recibido, desde),
				eq(s.eventos.conexionEstablecida, true),
				isNotNull(s.eventos.ip),
				/* Lo que provoca «Probar» viene de un equipo del propio cliente: no es un indicador. */
				eq(s.eventos.prueba, false)
			)
		)
		.groupBy(s.eventos.ip);
	const blanca = await blancas();
	const hasta = filas.reduce((m, f) => (new Date(f.hasta) > m ? new Date(f.hasta) : m), desde);
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

export async function marcarSubidos(hasta: Date) {
	const valor: Marca = { hasta: hasta.toISOString() };
	await db
		.insert(s.ajustes)
		.values({ clave: 'indicadores', valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

/* Sustituye la lista negra global por la recibida, si viene firmada por el panel fijado en el alta. */
export async function aplicarLista(clavePublicaPanel: string, f: ListaFirmada, nodo: string) {
	const v = verificarLista(clavePublicaPanel, f);
	if (!v.ok) {
		await auditar(`nodo ${nodo}`, 'lista global rechazada', { motivo: v.motivo });
		return false;
	}
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
					quien: 'SeguridadSI'
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
	const blanca = await blancas();
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
		.flatMap((v) => restar(v, blanca));
	return [...new Set(vigentes)].sort();
}
