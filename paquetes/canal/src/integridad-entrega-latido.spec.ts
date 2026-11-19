/* La integridad y lo apartado de la entrega en el latido (F33, F34): lo que acepta el panel. */
import { describe, expect, it } from 'vitest';
import { leerEntregaLatido, leerIntegridadLatido } from './index.ts';

describe('leerIntegridadLatido', () => {
	it('acepta la fecha y el número de desviaciones', () => {
		expect(leerIntegridadLatido({ comprobado: '2026-11-18T10:00:00Z', desviaciones: 2 })).toEqual({
			comprobado: '2026-11-18T10:00:00.000Z',
			desviaciones: 2
		});
	});
	it('ignora lo mal formado, y el detalle nunca pasa', () => {
		expect(leerIntegridadLatido(null)).toBeUndefined();
		expect(leerIntegridadLatido({ comprobado: 'ayer', desviaciones: 0 })).toBeUndefined();
		expect(
			leerIntegridadLatido({ comprobado: '2026-11-18T10:00:00Z', desviaciones: -1 })
		).toBeUndefined();
		expect(
			leerIntegridadLatido({ comprobado: '2026-11-18T10:00:00Z', desviaciones: 1.5 })
		).toBeUndefined();
		expect(
			leerIntegridadLatido({
				comprobado: '2026-11-18T10:00:00Z',
				desviaciones: 1,
				detalle: '/etc/passwd'
			})
		).toEqual({ comprobado: '2026-11-18T10:00:00.000Z', desviaciones: 1 });
	});
});

describe('leerEntregaLatido', () => {
	it('acepta cuántas y en cuántos sensores', () => {
		expect(leerEntregaLatido({ apartadas: 3, sensores: 1 })).toEqual({ apartadas: 3, sensores: 1 });
	});
	it('ignora lo mal formado', () => {
		expect(leerEntregaLatido({ apartadas: '3', sensores: 1 })).toBeUndefined();
		expect(leerEntregaLatido({ apartadas: 3 })).toBeUndefined();
		expect(leerEntregaLatido(undefined)).toBeUndefined();
	});
});
