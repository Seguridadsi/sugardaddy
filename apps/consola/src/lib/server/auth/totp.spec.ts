/*
 * TOTP contra los vectores de la RFC 6238 (apéndice B, SHA-1) y lo que lo
 * rodea: base32, ventana de un intervalo, formato y la dirección otpauth://.
 */
import { describe, expect, it } from 'vitest';
import {
	base32,
	codigo,
	comprobar,
	desdeBase32,
	generarSecreto,
	pasoDe,
	secretoLegible,
	uriOtpauth
} from './totp';

const SEMILLA = Buffer.from('12345678901234567890');

describe('TOTP (RFC 6238)', () => {
	/* La RFC da 8 cifras; las 6 de la derecha son las mismas con 6. */
	it.each([
		[59, '287082'],
		[1111111109, '081804'],
		[1111111111, '050471'],
		[1234567890, '005924'],
		[2000000000, '279037'],
		[20000000000, '353130']
	])('t=%i → %s', (t, esperado) => {
		expect(codigo(SEMILLA, pasoDe(t * 1000))).toBe(esperado);
	});

	it('base32 de ida y vuelta, sin relleno', () => {
		expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
		expect(desdeBase32('mzxw 6ytb-oi')?.toString()).toBe('foobar');
		expect(desdeBase32('MZ1')).toBeNull();
		const s = generarSecreto();
		expect(s).toMatch(/^[A-Z2-7]{32}$/);
		expect(desdeBase32(s)).toHaveLength(20);
	});

	it('acepta el intervalo de antes y el de después, no más', () => {
		const s = base32(SEMILLA);
		const t = 1111111111_000;
		const p = pasoDe(t);
		expect(comprobar(s, codigo(SEMILLA, p), t)).toBe(p);
		expect(comprobar(s, codigo(SEMILLA, p - 1), t)).toBe(p - 1);
		expect(comprobar(s, codigo(SEMILLA, p + 1), t)).toBe(p + 1);
		expect(comprobar(s, codigo(SEMILLA, p - 2), t)).toBeNull();
		expect(comprobar(s, codigo(SEMILLA, p + 2), t)).toBeNull();
	});

	it('rechaza lo que no son seis cifras y admite espacios', () => {
		const s = base32(SEMILLA);
		const t = 59_000;
		expect(comprobar(s, '287 082', t)).toBe(pasoDe(t));
		expect(comprobar(s, '28708', t)).toBeNull();
		expect(comprobar(s, '2870822', t)).toBeNull();
		expect(comprobar(s, 'abcdef', t)).toBeNull();
		expect(comprobar('corto', '287082', t)).toBeNull();
	});

	it('la dirección otpauth:// lleva emisor, cuenta y parámetros', () => {
		const texto = uriOtpauth('JBSWY3DPEHPK3PXP', 'ana@consola.example');
		expect(texto.startsWith('otpauth://totp/Sugardaddy:ana%40consola.example?')).toBe(true);
		const u = new URL(texto);
		expect(u.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
		expect(u.searchParams.get('issuer')).toBe('Sugardaddy');
		expect(u.searchParams.get('digits')).toBe('6');
		expect(u.searchParams.get('period')).toBe('30');
		expect(secretoLegible('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
	});
});
