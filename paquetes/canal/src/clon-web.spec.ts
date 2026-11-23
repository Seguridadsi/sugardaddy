import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	MAX_PROPIOS,
	clasificarVisitaClon,
	dominiosPropios,
	huellaSitio,
	segmentoPropios,
	visitaPropiaPorHuellas
} from './clon-web.ts';

/* El mismo vector que usa el relé (rele/clon_test.go). */
const v = JSON.parse(readFileSync(new URL('./vectores/clon-web.json', import.meta.url), 'utf8'));

describe('la web clonada', () => {
	it('resume los sitios igual que el relé', () => {
		for (const p of v.propios) expect(huellaSitio(p)).toBe(v.huellas[p]);
		expect(segmentoPropios(v.propios)).toBe(v.segmento);
	});

	it('decide igual que el relé con las huellas, y la consola igual con los nombres', () => {
		const huellas = new Set<string>(Object.values(v.huellas));
		for (const c of v.casos) {
			expect(visitaPropiaPorHuellas(c.referer, huellas), c.referer).toBe(c.propia);
			const clase = clasificarVisitaClon(c.referer, v.propios).clase;
			expect(clase !== 'clon', c.referer).toBe(c.propia);
		}
	});

	it('dice el sitio del clon', () => {
		expect(clasificarVisitaClon('https://Login-Ejemplo.example:443/x', ['ejemplo.com'])).toEqual({
			clase: 'clon',
			sitio: 'login-ejemplo.example'
		});
		expect(clasificarVisitaClon(undefined, ['ejemplo.com'])).toEqual({ clase: 'sin-referer' });
	});

	it('limpia los dominios que escribe el cliente', () => {
		expect(
			dominiosPropios('https://www.Ejemplo.com/acceso, ejemplo.com  *.portal.es;bad_name x')
		).toEqual({
			dominios: ['www.ejemplo.com', 'ejemplo.com', 'portal.es'],
			malos: ['bad_name', 'x']
		});
		expect(dominiosPropios(undefined)).toEqual({ dominios: [], malos: [] });
		const muchos = Array.from({ length: 12 }, (_, i) => `s${i}.ejemplo.com`).join(',');
		expect(dominiosPropios(muchos).dominios).toHaveLength(MAX_PROPIOS);
		expect(dominiosPropios('192.168.1.1 localhost').dominios).toEqual([]);
	});
});
