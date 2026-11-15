/* Sin base de datos: lo usan también las decisiones puras (lista-comun-frenos.ts). */
import { isIP } from 'node:net';

/* Una IPv4 escrita como IPv6 (::ffff:1.2.3.4) es esa IPv4; si no, no casaría con la otra forma. */
export function sinMapear(ip: string): string {
	if (isIP(ip) !== 6) return ip;
	try {
		const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(
			new URL(`http://[${ip}]`).hostname
		);
		if (!m) return ip;
		const [a, b] = [parseInt(m[1], 16), parseInt(m[2], 16)];
		return [a >> 8, a & 0xff, b >> 8, b & 0xff].join('.');
	} catch {
		return ip;
	}
}
