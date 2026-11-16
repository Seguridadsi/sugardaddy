import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {}, schema: {} }));
vi.mock('./consultas', () => ({ auditar: vi.fn() }));
import { esLectura, rutaGrabada } from './soporte-registro';

describe('lo que se graba de una petición del soporte', () => {
	it('la página, no su __data.json, y la acción del formulario aparte', () => {
		expect(rutaGrabada(new URL('https://c/decoys/__data.json?x-sveltekit-invalidated=01'))).toEqual(
			{ ruta: '/decoys', accion: null }
		);
		expect(rutaGrabada(new URL('https://c/users?/roles'))).toEqual({
			ruta: '/users',
			accion: 'roles'
		});
		expect(rutaGrabada(new URL('https://c/events?q=ssh&page=2'))).toEqual({
			ruta: '/events?q=ssh&page=2',
			accion: null
		});
		expect(rutaGrabada(new URL('https://c/__data.json')).ruta).toBe('/');
	});

	it('una ruta larga se recorta', () => {
		expect(rutaGrabada(new URL(`https://c/events?q=${'a'.repeat(1000)}`)).ruta.length).toBe(300);
	});

	it('qué es una lectura', () => {
		expect(esLectura('GET')).toBe(true);
		expect(esLectura('HEAD')).toBe(true);
		expect(esLectura('POST')).toBe(false);
	});
});
