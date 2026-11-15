/*
 * Qué direcciones no entran nunca en la lista común (docs/diseno/frenos-del-nodo.md, R1-B y
 * R3-C del análisis del 2026-11-14). Lo comprueban el panel antes de propagar y el nodo antes
 * de meter nada en el EDL: el nodo no se fía de que el panel lo haya hecho.
 *
 * - Lo que no es una IP pública (esIpPublica): privadas, documentación y el CGNAT de las
 *   operadoras, 100.64.0.0/10, detrás del que van miles de móviles a la vez.
 * - Las nubes públicas y las CDN (rangos-nubes-datos.ts, generado de sus fuentes oficiales):
 *   por ahí sale el tráfico de miles de clientes suyos y de los SaaS que usa el cliente.
 *   Bloquear una por lo que hizo uno es justo lo que buscaría quien envenena la lista.
 */
import { esIpPublica } from './indicadores.ts';
import { rango } from './rangos.ts';
import { RANGOS_NUBES } from './rangos-nubes-datos.ts';

type Tramo = { desde: bigint; hasta: bigint; proveedor: number };
type Indice = { tramos: Tramo[]; techo: Tramo[] };

let indices: Record<4 | 6, Indice> | null = null;

/*
 * Una vez, al primer uso: todos los tramos de una familia ordenados por su inicio y, para
 * cada posición, el tramo de hasta más alto visto hasta ahí. Con eso basta una búsqueda
 * binaria aunque los proveedores se solapen (Google y Google Cloud).
 */
function indice(familia: 4 | 6): Indice {
	if (!indices) {
		const por: Record<4 | 6, Tramo[]> = { 4: [], 6: [] };
		RANGOS_NUBES.forEach((p, proveedor) => {
			for (const r of p.rangos.split(' ')) {
				const x = rango(r);
				if (x) por[x.familia].push({ desde: x.desde, hasta: x.hasta, proveedor });
			}
		});
		const hacer = (tramos: Tramo[]): Indice => {
			tramos.sort((a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : 0));
			const techo: Tramo[] = [];
			for (const t of tramos) {
				const u = techo.at(-1);
				techo.push(u && u.hasta >= t.hasta ? u : t);
			}
			return { tramos, techo };
		};
		indices = { 4: hacer(por[4]), 6: hacer(por[6]) };
	}
	return indices[familia];
}

/*
 * Los resolvedores DNS públicos más usados: si uno entra en el EDL, las máquinas del cliente
 * que lo usan se quedan sin nombres. La pasarela y los DNS de la red del cliente son privados
 * y ya no pasan esIpPublica; su IP de salida la protege el nodo (ips-propias.ts de la consola).
 */
export const RESOLVEDORES_PUBLICOS: readonly string[] = [
	'1.1.1.1',
	'1.0.0.1',
	'8.8.8.8',
	'8.8.4.4',
	'9.9.9.9',
	'149.112.112.112',
	'208.67.222.222',
	'208.67.220.220',
	'94.140.14.14',
	'94.140.15.15',
	'2606:4700:4700::1111',
	'2606:4700:4700::1001',
	'2001:4860:4860::8888',
	'2001:4860:4860::8844',
	'2620:fe::fe',
	'2620:fe::9',
	'2620:119:35::35',
	'2620:119:53::53'
];

/* De qué nube o CDN es esta IP, o null. */
export function nubeDeIp(ip: string): { id: string; nombre: string } | null {
	const r = rango(ip);
	if (!r || r.desde !== r.hasta) return null;
	const { tramos, techo } = indice(r.familia);
	/* El último tramo que empieza en la IP o antes. */
	let a = 0;
	let b = tramos.length - 1;
	let i = -1;
	while (a <= b) {
		const m = (a + b) >> 1;
		if (tramos[m].desde <= r.desde) {
			i = m;
			a = m + 1;
		} else b = m - 1;
	}
	if (i < 0 || techo[i].hasta < r.desde) return null;
	const p = RANGOS_NUBES[techo[i].proveedor];
	return { id: p.id, nombre: p.nombre };
}

/*
 * Por qué esta IP no puede entrar en la lista común, o null si puede. Solo IPs sueltas: una
 * red de la lista común bloquearía a terceros que nadie ha visto atacar.
 */
export function motivoNoCompartible(ip: string): string | null {
	const r = rango(ip);
	if (!r || r.desde !== r.hasta || ip.includes('/')) return 'not a single IP address';
	if (!esIpPublica(ip)) return 'not a public address (private, reserved or carrier-grade NAT)';
	if (
		RESOLVEDORES_PUBLICOS.some(
			(d) => rango(d)?.desde === r.desde && rango(d)?.familia === r.familia
		)
	)
		return 'public DNS resolver';
	const n = nubeDeIp(ip);
	return n ? `shared address of ${n.nombre}` : null;
}
