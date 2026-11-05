/*
 * Quién firma los textos de la consola: el nombre que manda el panel, o SeguridadSI
 * si no hay panel o no manda ninguno.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {}, schema: {} }));
const { operadorDe } = await import('./operador');

describe('operadorDe', () => {
	it('sin canal, o sin nombre, es SeguridadSI', () => {
		for (const c of [undefined, null, {}, { estado: null }, { estado: {} }])
			expect(operadorDe(c)).toBe('SeguridadSI');
	});

	it('con el nombre del MSP, ese', () => {
		expect(operadorDe({ estado: { operador: ' ACME Seguridad ' } })).toBe('ACME Seguridad');
	});

	it('un nombre vacío o de otro tipo no vale', () => {
		for (const operador of ['', '   ', 7, {}, null])
			expect(operadorDe({ estado: { operador } })).toBe('SeguridadSI');
	});

	it('se acota', () => {
		expect(operadorDe({ estado: { operador: 'x'.repeat(500) } })).toHaveLength(60);
	});
});
