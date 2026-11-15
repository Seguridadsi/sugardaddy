import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {}, schema: {} }));
vi.mock('./consultas', () => ({ auditar: vi.fn() }));
vi.mock('./operador', () => ({ operador: async () => 'SeguridadSI' }));
import { AVISO_MS, MAXIMO_HORAS, horasValidas, porCaducar, type Soporte } from './soporte';

describe('plazo del acceso de soporte', () => {
	it('nunca pasa de 30 días, y lo que no es un plazo da el de por defecto (30 días)', () => {
		expect(MAXIMO_HORAS).toBe(720);
		expect(horasValidas(8)).toBe(8);
		expect(horasValidas('168')).toBe(168);
		expect(horasValidas(10_000)).toBe(720);
		expect(horasValidas('continuo')).toBe(720);
		expect(horasValidas(null)).toBe(720);
		expect(horasValidas(-5)).toBe(720);
	});

	it('avisa cuando quedan menos de 3 días', () => {
		const ahora = Date.parse('2026-11-14T12:00:00Z');
		const abierto = (ms: number): Soporte => ({
			estado: 'abierto',
			solicitud: null,
			rol: 'lector',
			hasta: new Date(ahora + ms).toISOString()
		});
		expect(porCaducar(abierto(AVISO_MS - 1), ahora)).toBe(true);
		expect(porCaducar(abierto(AVISO_MS + 60_000), ahora)).toBe(false);
		expect(porCaducar({ ...abierto(1000), estado: 'cerrado' }, ahora)).toBe(false);
	});
});
