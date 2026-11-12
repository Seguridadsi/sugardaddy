/*
 * Una IP escrita en el buscador de Events. Quien pega «88.21.10.197» busca los
 * eventos que vienen de esa dirección, no un texto: se filtra por el origen,
 * que tiene índice, en vez de leer la línea de cada evento. Vale una dirección
 * entera (IPv4 o IPv6, en cualquiera de sus escrituras) o un prefijo CIDR.
 * Cualquier otra cosa (media IP, una IP con más palabras) sigue siendo texto.
 */
import { isIP } from 'node:net';

/* Como normalizarIp de pruebas.ts, sin traerse la base: aquí solo hay texto. */
function normalizar(ip: string): string | null {
	let t = ip.toLowerCase().replace(/^\[(.*)\]$/, '$1');
	t = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t)?.[1] ?? t;
	const v = isIP(t);
	if (v === 4) return t;
	if (v === 6) return new URL(`http://[${t}]`).hostname.slice(1, -1);
	return null;
}

export type IpBuscada =
	| { clase: 'ip'; ip: string }
	/* `comun`: los octetos enteros que comparten todas las IPv4 del prefijo («88.21.»). */
	| { clase: 'cidr'; cidr: string; comun: string | null };

export function ipBuscada(q: string | null | undefined): IpBuscada | null {
	const t = q?.trim() ?? '';
	if (!t || /\s/.test(t)) return null;
	const barra = t.indexOf('/');
	if (barra < 0) {
		const ip = normalizar(t);
		return ip ? { clase: 'ip', ip } : null;
	}
	const base = t.slice(0, barra).replace(/^\[(.*)\]$/, '$1');
	const bits = t.slice(barra + 1);
	const familia = isIP(base);
	if (!familia || !/^\d{1,3}$/.test(bits)) return null;
	const n = Number(bits);
	if (n > (familia === 4 ? 32 : 128)) return null;
	const octetos = familia === 4 ? base.split('.').slice(0, Math.floor(n / 8)) : [];
	return {
		clase: 'cidr',
		cidr: `${base.toLowerCase()}/${n}`,
		comun: octetos.length ? (n === 32 ? base : octetos.join('.') + '.') : null
	};
}
