/*
 * Las reglas del plazo de conservación, sin base de datos: qué plazos valen y
 * desde cuándo se borra.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {}, schema: {} }));
vi.mock('./consultas', () => ({ auditar: async () => {} }));
const { DIAS_MAXIMO, DIAS_MINIMO, limiteDeAuditoria, limiteDeBorrado, validarDias } =
	await import('./conservacion');

const ahora = new Date('2026-10-21T12:00:00Z');

describe('plazo de conservación', () => {
	it('vale un número entero de días entre el mínimo y el máximo', () => {
		expect(validarDias('365')).toBe(365);
		expect(validarDias(` ${DIAS_MINIMO} `)).toBe(DIAS_MINIMO);
		expect(validarDias(DIAS_MAXIMO)).toBe(DIAS_MAXIMO);
		for (const malo of ['', '29', String(DIAS_MAXIMO + 1), '90.5', 'un año', '-365', null])
			expect(validarDias(malo), String(malo)).toBeNull();
	});

	it('no borra nada mientras dura el aviso', () => {
		const c = { dias: 365, aPartirDe: '2026-11-20T12:00:00Z' };
		expect(limiteDeBorrado(c, ahora)).toBeNull();
	});

	it('la auditoría se guarda al menos un año, o el plazo de los eventos si es más', () => {
		const corto = { dias: 90, aPartirDe: '2026-10-01T00:00:00Z' };
		const largo = { dias: 730, aPartirDe: '2026-10-01T00:00:00Z' };
		expect(limiteDeAuditoria(corto, ahora)?.toISOString()).toBe('2025-10-21T12:00:00.000Z');
		expect(limiteDeAuditoria(largo, ahora)?.toISOString()).toBe('2024-10-21T12:00:00.000Z');
		expect(limiteDeAuditoria({ ...corto, aPartirDe: '2026-11-20T12:00:00Z' }, ahora)).toBeNull();
	});

	it('pasado el aviso, borra lo de antes del plazo', () => {
		const c = { dias: 365, aPartirDe: '2026-10-01T00:00:00Z' };
		expect(limiteDeBorrado(c, ahora)?.toISOString()).toBe('2025-10-21T12:00:00.000Z');
	});
});
