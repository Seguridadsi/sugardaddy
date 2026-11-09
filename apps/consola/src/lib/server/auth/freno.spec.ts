import { describe, expect, it } from 'vitest';
import { Freno, claveIp } from './freno';

describe('Freno', () => {
	it('deja pasar hasta el tope por clave y ventana, y vuelve a abrir en la siguiente', () => {
		const f = new Freno(3, 1000);
		expect([1, 2, 3, 4].map(() => f.pasa('a', 0))).toEqual([true, true, true, false]);
		expect(f.pasa('b', 0)).toBe(true);
		expect(f.pasa('a', 999)).toBe(false);
		expect(f.pasa('a', 1000)).toBe(true);
	});

	it('muchas claves distintas no lo hacen crecer sin fin', () => {
		const f = new Freno(1, 60_000);
		for (let i = 0; i < 25_000; i++) f.pasa(`ip:${i}`, i);
		expect((f as unknown as { ventanas: Map<string, unknown> }).ventanas.size).toBeLessThanOrEqual(
			10_000
		);
	});

	it('las peticiones sin IP comparten cupo', () => {
		expect(claveIp(null)).toBe(claveIp(undefined));
		expect(claveIp('203.0.113.1')).not.toBe(claveIp('203.0.113.2'));
	});
});
