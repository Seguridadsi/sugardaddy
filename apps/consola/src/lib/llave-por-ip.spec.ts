import { describe, expect, it } from 'vitest';
import { esIp, sinLlavePorIp } from './llave-por-ip';

describe('llaves FIDO2 y entrar por IP', () => {
	it('reconoce IPv4 e IPv6 y deja pasar los nombres', () => {
		for (const h of ['20.115.90.87', '10.0.0.11', '::1', '[fe80::1]']) expect(esIp(h)).toBe(true);
		for (const h of ['consola.empresa.es', 'localhost', 'sd-nodo']) expect(esIp(h)).toBe(false);
	});

	it('por IP lo explica y manda al código; por nombre, nada', () => {
		expect(sinLlavePorIp('20.115.90.87')).toContain('código de emergencia');
		expect(sinLlavePorIp('consola.empresa.es')).toBeNull();
	});
});
