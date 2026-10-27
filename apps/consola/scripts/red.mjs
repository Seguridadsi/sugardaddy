/*
 * La red y la VLAN de un sensor, como se leen de un formulario o del entorno.
 *
 * Sin dependencias: lo usan el arranque de la consola (preparar-base.mjs),
 * que corre en la imagen sin compilar y pone al sensor local la red que
 * detectó el instalador, y $lib/red.ts, para que se lean igual en los dos.
 */

const OCTETO = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/**
 * Una red IPv4 en CIDR, de /8 a /32, con la dirección de la red
 * (10.70.0.5/24 → 10.70.0.0/24). null si está vacía; undefined si no se
 * entiende.
 * @param {string} texto
 * @returns {string | null | undefined}
 */
export function leerRed(texto) {
	const t = texto.trim();
	if (!t) return null;
	const [ip, bits, ...resto] = t.split('/');
	const octetos = ip.split('.');
	if (resto.length || !/^\d{1,2}$/.test(bits ?? '') || octetos.length !== 4) return undefined;
	if (!octetos.every((o) => OCTETO.test(o))) return undefined;
	const n = Number(bits);
	if (n < 8 || n > 32) return undefined;
	const valor = octetos.reduce((a, o) => a * 256 + Number(o), 0);
	const red = valor - (valor % 2 ** (32 - n));
	return `${[24, 16, 8, 0].map((d) => Math.floor(red / 2 ** d) % 256).join('.')}/${n}`;
}

/**
 * Una VLAN (802.1Q, de 1 a 4094). null si está vacía; undefined si no se entiende.
 * @param {string} texto
 * @returns {number | null | undefined}
 */
export function leerVlan(texto) {
	const t = texto.trim();
	if (!t) return null;
	if (!/^\d{1,4}$/.test(t)) return undefined;
	const n = Number(t);
	return n >= 1 && n <= 4094 ? n : undefined;
}
