/*
 * Los frenos del nodo a la lista común (docs/diseno/frenos-del-nodo.md, R1-B y R3-C del
 * análisis del 2026-11-14). La lista viene firmada por el panel, pero el panel es un punto
 * único: tomado, firmaría para toda la flota lo que quisiera meter en el EDL de cada
 * firewall. Por eso el nodo no se fía y aplica él, sin que nadie tenga que aprobar nada:
 *
 *   - solo IPs sueltas y públicas, nunca de una nube, una CDN, el CGNAT de las operadoras o
 *     un DNS público (motivoNoCompartible, en @sugardaddy/canal);
 *   - nunca una IP del propio despliegue (ips-propias.ts);
 *   - como mucho TOPE_DIA nuevas al día; las demás esperan, visibles en Lists, y entran en
 *     días siguientes si siguen en la lista. Lo que ya estaba sigue sin gastar cupo.
 *
 * Aquí, la decisión pura; inteligencia.ts trae los datos y la guarda.
 */
import { contenidaEn, motivoNoCompartible, type IndicadorGlobal } from '@sugardaddy/canal';
import { sinMapear } from './sin-mapear';

export const TOPE_DIA_POR_DEFECTO = 100;

/* LISTA_COMUN_TOPE_DIA en el .env del nodo: entre 0 (no entra nada nuevo) y 10.000. */
export function topeDia(valor: string | undefined): number {
	const n = Number(valor);
	if (valor === undefined || valor.trim() === '' || !Number.isInteger(n))
		return TOPE_DIA_POR_DEFECTO;
	return Math.min(Math.max(n, 0), 10_000);
}

export type Reparto = {
	/* Ya estaban en el EDL y siguen en la lista: se quedan, sin gastar cupo. */
	mantener: IndicadorGlobal[];
	/* Nuevas que caben hoy. */
	entrar: IndicadorGlobal[];
	/* Nuevas que no caben hoy: a la espera. */
	esperar: IndicadorGlobal[];
	/* Lo que no entra nunca, con su motivo (para la auditoría). */
	rechazadas: { valor: string; motivo: string }[];
};

export function repartirListaComun(p: {
	entrantes: IndicadorGlobal[];
	/* Lo que ya está en el EDL como global. */
	admitidas: ReadonlySet<string>;
	/* Lo que ya esperaba y desde cuándo: entra antes lo que más lleva esperando. */
	esperaDesde: ReadonlyMap<string, Date>;
	cupo: number;
	intocables: ReadonlySet<string>;
}): Reparto {
	const r: Reparto = { mantener: [], entrar: [], esperar: [], rechazadas: [] };
	const intocables = [...p.intocables];
	const nuevas: IndicadorGlobal[] = [];
	const vistas = new Set<string>();
	for (const crudo of p.entrantes) {
		if (!crudo || typeof crudo.valor !== 'string') continue;
		/* ::ffff:1.2.3.4 es 1.2.3.4: se mira y se guarda como IPv4, una sola vez. */
		const i = { ...crudo, valor: sinMapear(crudo.valor) };
		if (vistas.has(i.valor)) continue;
		vistas.add(i.valor);
		const motivo =
			i.clase !== 'ip'
				? 'not a single IP address'
				: (motivoNoCompartible(i.valor) ??
					(contenidaEn(i.valor, intocables)
						? 'address of this deployment (node, sensor or its Internet exit)'
						: null));
		if (motivo) r.rechazadas.push({ valor: i.valor, motivo });
		else if (p.admitidas.has(i.valor)) r.mantener.push(i);
		else nuevas.push(i);
	}
	/* Primero lo que más lleva esperando; lo que llega hoy, en el orden de la lista. */
	const orden = (i: IndicadorGlobal) => p.esperaDesde.get(i.valor)?.getTime() ?? Infinity;
	nuevas
		.map((i, n) => ({ i, n }))
		.sort((a, b) => orden(a.i) - orden(b.i) || a.n - b.n)
		.forEach(({ i }, n) => (n < p.cupo ? r.entrar : r.esperar).push(i));
	return r;
}

/* El día del cupo, en UTC: el mismo para todo el nodo, sin depender de su zona. */
export const diaDe = (d: Date) => d.toISOString().slice(0, 10);
