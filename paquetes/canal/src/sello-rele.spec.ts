import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	abrirRele,
	claveDeTokenRele,
	nuevaClaveSello,
	rutaRele,
	sellarRele,
	tokenSellado,
	type Sellada
} from './sello-rele.ts';

/* El mismo vector que sella el relé (rele/sello_test.go). */
const v = JSON.parse(readFileSync(new URL('./vectores/sello-rele.json', import.meta.url), 'utf8'));
const de = (s: string) => Buffer.from(s, 'base64url');

describe('el sello de las señales del relé', () => {
	it('abre lo que sella el relé, y sella igual que él', () => {
		expect(claveDeTokenRele(v.token)?.toString('base64url')).toBe(v.publicaNodo);
		expect(rutaRele(v.token)).toBe(v.ruta);
		expect(abrirRele(v.sellada, de(v.privadaNodo))?.toString()).toBe(v.linea);
		expect(sellarRele(v.token, Buffer.from(v.linea), de(v.efimera))).toEqual(v.sellada);
	});

	it('no abre con otra clave, ni tocado, ni pasado a otra ruta', () => {
		const otra = nuevaClaveSello();
		expect(abrirRele(v.sellada, otra.privada)).toBeNull();
		const c = de(v.sellada.c);
		c[0] ^= 1;
		expect(abrirRele({ ...v.sellada, c: c.toString('base64url') }, de(v.privadaNodo))).toBeNull();
		expect(abrirRele({ ...v.sellada, r: rutaRele('otro') }, de(v.privadaNodo))).toBeNull();
		expect(abrirRele({ ...v.sellada, v: 2 } as unknown as Sellada, de(v.privadaNodo))).toBeNull();
	});

	it('un token de los de antes no tiene clave y no se confunde con uno sellado', () => {
		expect(claveDeTokenRele('AAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
		expect(claveDeTokenRele('x' + v.token.slice(1))).toBeNull();
		/* Sigue la forma que aceptan el relé y el panel de antes. */
		expect(v.token).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
	});

	it('de punta a punta con una clave nueva', () => {
		const { publica, privada } = nuevaClaveSello();
		const token = tokenSellado(publica);
		const s = sellarRele(token, Buffer.from('{"ip":"203.0.113.9"}'));
		expect(s.r).toBe(rutaRele(token));
		expect(JSON.stringify(s)).not.toContain('203.0.113.9');
		expect(abrirRele(s, privada)?.toString()).toBe('{"ip":"203.0.113.9"}');
	});
});
