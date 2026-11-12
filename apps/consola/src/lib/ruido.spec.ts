import { describe, expect, it } from 'vitest';
import { noAccionables, parteDeRuido, porcentaje, ruidoPorMil } from './ruido';

const t = (eventos: number, escaner: number, falsosPositivos: number, confirmados = 0) => ({
	id: 'x',
	nombre: 'x',
	modulo: 'cowrie',
	eventos,
	escaner,
	falsosPositivos,
	confirmados
});

describe('la métrica de ruido', () => {
	it('no accionable es lo de los escáneres más lo marcado como falso positivo', () => {
		expect(noAccionables(t(100, 7, 3))).toBe(10);
		expect(parteDeRuido(t(100, 7, 3))).toBe(0.1);
		expect(porcentaje(parteDeRuido(t(100, 7, 3)))).toBe('10%');
	});

	it('sin eventos no hay parte que dar', () => {
		expect(parteDeRuido(t(0, 0, 0))).toBeNull();
		expect(porcentaje(null)).toBe('—');
	});

	it('por cada 1.000 honeypots y mes, ajustado a los días mirados', () => {
		/* 2 honeypots, 6 no accionables en 30 días: 3 por honeypot → 3.000 por mil. */
		expect(ruidoPorMil([t(50, 4, 0), t(10, 1, 1)], 30)).toBe(3000);
		/* Lo mismo visto en 15 días es el doble al mes. */
		expect(ruidoPorMil([t(50, 4, 0), t(10, 1, 1)], 15)).toBe(6000);
		expect(ruidoPorMil([], 30)).toBeNull();
	});
});
