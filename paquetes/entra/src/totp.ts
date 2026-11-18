/*
 * Códigos de un solo uso por tiempo (TOTP, RFC 6238 sobre HOTP, RFC 4226): lo
 * que enseñan Microsoft Authenticator, Google Authenticator, 1Password y las
 * demás apps. Parámetros de siempre, los únicos que todas aceptan: HMAC-SHA1,
 * 6 cifras, intervalos de 30 s. Sin dependencias: son veinte líneas de crypto.
 *
 * El secreto son 20 bytes al azar (160 bits, lo que recomienda la RFC 4226),
 * en base32 sin relleno para la app.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PERIODO_S = 30;
export const CIFRAS = 6;
/* Un intervalo antes y uno después: relojes de móvil que van algo desfasados. */
export const VENTANA = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(b: Uint8Array): string {
	let bits = 0;
	let valor = 0;
	let s = '';
	for (const x of b) {
		valor = (valor << 8) | x;
		bits += 8;
		while (bits >= 5) {
			s += B32[(valor >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) s += B32[(valor << (5 - bits)) & 31];
	return s;
}

export function desdeBase32(s: string): Buffer | null {
	const limpio = s.toUpperCase().replace(/[\s=-]/g, '');
	let bits = 0;
	let valor = 0;
	const out: number[] = [];
	for (const c of limpio) {
		const i = B32.indexOf(c);
		if (i < 0) return null;
		valor = (valor << 5) | i;
		bits += 5;
		if (bits >= 8) {
			out.push((valor >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export const generarSecreto = () => base32(randomBytes(20));

/* El intervalo de 30 s de un instante. */
export const pasoDe = (ms: number) => Math.floor(ms / 1000 / PERIODO_S);

/* HOTP del intervalo `paso` (RFC 4226 §5.3, truncado dinámico). */
export function codigo(secreto: Buffer, paso: number): string {
	const contador = Buffer.alloc(8);
	contador.writeBigUInt64BE(BigInt(paso));
	const h = createHmac('sha1', secreto).update(contador).digest();
	const o = h[h.length - 1] & 0xf;
	const n = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** CIFRAS;
	return String(n).padStart(CIFRAS, '0');
}

/*
 * El intervalo con el que casa `escrito`, o null. Se miran todos los de la
 * ventana (sin cortar al primero) y se comparan en tiempo constante. Quien
 * llama tiene que rechazar un intervalo que no sea posterior al último usado:
 * así el mismo código no vale dos veces.
 */
export function comprobar(secretoB32: string, escrito: string, ahora = Date.now()): number | null {
	const limpio = escrito.replace(/\s/g, '');
	if (!/^\d{6}$/.test(limpio)) return null;
	const secreto = desdeBase32(secretoB32);
	if (!secreto || secreto.length < 10) return null;
	const actual = pasoDe(ahora);
	let casa: number | null = null;
	for (let d = -VENTANA; d <= VENTANA; d++) {
		const c = Buffer.from(codigo(secreto, actual + d));
		if (timingSafeEqual(c, Buffer.from(limpio)) && casa === null) casa = actual + d;
	}
	return casa;
}

/*
 * La dirección otpauth:// que lee la app (en el QR). La etiqueta lleva el
 * nombre de la consola para que, con varias, se distingan en la app.
 */
export function uriOtpauth(secretoB32: string, cuenta: string, emisor = 'Sugardaddy'): string {
	const etiqueta = `${encodeURIComponent(emisor)}:${encodeURIComponent(cuenta)}`;
	const p = new URLSearchParams({
		secret: secretoB32,
		issuer: emisor,
		algorithm: 'SHA1',
		digits: String(CIFRAS),
		period: String(PERIODO_S)
	});
	return `otpauth://totp/${etiqueta}?${p}`;
}

/* El secreto en grupos de cuatro, para teclearlo a mano en la app. */
export const secretoLegible = (s: string) => s.match(/.{1,4}/g)!.join(' ');
