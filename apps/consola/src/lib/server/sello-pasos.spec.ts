import { describe, expect, it, vi } from 'vitest';

/* El nodo de prueba tiene su CLAVE_SECRETOS; se cambia para los casos sin clave o con otra. */
const env: Record<string, string | undefined> = { CLAVE_SECRETOS: 'ab'.repeat(32) };
vi.mock('$env/dynamic/private', () => ({ env }));

const { sellarPasos, comprobarSello } = await import('./sello-pasos');

const SHA = 'a'.repeat(64);

describe('el sello de unos pasos (BAL-10)', () => {
	it('sella con «v1.<id de la clave>.<HMAC>» y se comprueba', () => {
		const sello = sellarPasos(SHA);
		expect(sello).toMatch(/^v1\.[0-9a-f]{16}\.[A-Za-z0-9_-]+$/);
		expect(comprobarSello(SHA, sello!)).toBe('ok');
	});

	it('no cuadra si cambian los pasos (otro sha256) o el propio HMAC', () => {
		const sello = sellarPasos(SHA)!;
		expect(comprobarSello('b'.repeat(64), sello)).toBe('no-cuadra');
		const roto = sello.slice(0, -1) + (sello.endsWith('A') ? 'B' : 'A');
		expect(comprobarSello(SHA, roto)).toBe('no-cuadra');
	});

	it('mal formado si no es v1.<id>.<mac>', () => {
		for (const malo of ['', 'x', 'v1.abc', 'v2.0000000000000000.AAAA'])
			expect(comprobarSello(SHA, malo)).toBe('mal-formado');
	});

	it('dice «otra-clave» cuando lo firmó una clave del nodo distinta', () => {
		const sello = sellarPasos(SHA)!;
		const previa = env.CLAVE_SECRETOS;
		env.CLAVE_SECRETOS = 'cd'.repeat(32);
		try {
			expect(comprobarSello(SHA, sello)).toBe('otra-clave');
		} finally {
			env.CLAVE_SECRETOS = previa;
		}
	});

	it('sin clave en el nodo no hay sello y no se puede comprobar', () => {
		const sello = sellarPasos(SHA)!;
		const previa = env.CLAVE_SECRETOS;
		env.CLAVE_SECRETOS = undefined;
		try {
			expect(sellarPasos(SHA)).toBeNull();
			expect(comprobarSello(SHA, sello)).toBe('sin-clave');
		} finally {
			env.CLAVE_SECRETOS = previa;
		}
	});
});
