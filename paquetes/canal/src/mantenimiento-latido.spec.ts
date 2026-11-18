/* Lo que el panel acepta de la ventana de mantenimiento del latido (puro). */
import { describe, expect, it } from 'vitest';
import { enMantenimiento, leerMantenimientoLatido } from './index.ts';

const AHORA = Date.parse('2026-11-17T10:00:00Z');

describe('leerMantenimientoLatido', () => {
	it('acepta una bien formada y la normaliza', () => {
		expect(
			leerMantenimientoLatido(
				{ hasta: '2026-11-17T12:00:00+00:00', nodo: true, sensoresParados: 2, otra: 'x' },
				AHORA
			)
		).toEqual({ hasta: '2026-11-17T12:00:00.000Z', nodo: true, sensoresParados: 2 });
	});

	it('ignora lo mal formado y lo que dura más de una semana', () => {
		for (const x of [
			undefined,
			null,
			'si',
			{ hasta: 'mañana', nodo: true, sensoresParados: 0 },
			{ hasta: '2026-11-17T12:00:00Z', nodo: 'si', sensoresParados: 0 },
			{ hasta: '2026-11-17T12:00:00Z', nodo: true, sensoresParados: -1 },
			{ hasta: '2026-11-17T12:00:00Z', nodo: true, sensoresParados: 1.5 },
			{ hasta: '2026-12-17T12:00:00Z', nodo: true, sensoresParados: 0 }
		])
			expect(leerMantenimientoLatido(x, AHORA)).toBeUndefined();
	});

	it('en curso solo hasta su fin', () => {
		const m = { hasta: '2026-11-17T12:00:00Z', nodo: true, sensoresParados: 0 };
		expect(enMantenimiento(m, AHORA)).toBe(true);
		expect(enMantenimiento(m, Date.parse('2026-11-17T12:00:01Z'))).toBe(false);
		expect(enMantenimiento(undefined, AHORA)).toBe(false);
	});
});
