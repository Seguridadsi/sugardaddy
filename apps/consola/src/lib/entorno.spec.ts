/*
 * La lógica pura del entorno: qué gana al resolver (honeypot sobre sensor) y
 * cuándo se puede contener el origen. Sin base de datos ni red.
 */
import { describe, expect, it } from 'vitest';
import {
	ENTORNOS,
	ENTORNO_ETIQUETA,
	contieneElOrigen,
	entornoDe,
	esEntorno,
	type Entorno
} from './entorno';

describe('qué entorno gana', () => {
	it('el de la trampa manda sobre el del sensor', () => {
		expect(entornoDe('perimetro-web', 'dentro')).toBe('perimetro-web');
		expect(entornoDe('dentro', 'perimetro-web')).toBe('dentro');
	});

	it('sin el de la trampa, hereda el del sensor', () => {
		expect(entornoDe(null, 'dentro')).toBe('dentro');
		expect(entornoDe(undefined, 'aislada')).toBe('aislada');
	});

	it('sin ninguno, no hay entorno', () => {
		expect(entornoDe(null, null)).toBeNull();
		expect(entornoDe(undefined, undefined)).toBeNull();
	});
});

describe('cuándo se contiene el origen', () => {
	it('dentro y aislada permiten contener; la web no', () => {
		expect(contieneElOrigen('dentro')).toBe(true);
		expect(contieneElOrigen('aislada')).toBe(true);
		expect(contieneElOrigen('perimetro-web')).toBe(false);
	});

	it('sin entorno puesto, se permite (como antes de esta función)', () => {
		expect(contieneElOrigen(null)).toBe(true);
		expect(contieneElOrigen(undefined)).toBe(true);
	});
});

describe('validación y etiquetas', () => {
	it('esEntorno acepta solo los tres válidos', () => {
		for (const e of ENTORNOS) expect(esEntorno(e)).toBe(true);
		expect(esEntorno('fuera')).toBe(false);
		expect(esEntorno(null)).toBe(false);
		expect(esEntorno(2)).toBe(false);
	});

	it('cada entorno tiene etiqueta', () => {
		for (const e of ENTORNOS) expect(ENTORNO_ETIQUETA[e as Entorno].length).toBeGreaterThan(0);
	});
});
