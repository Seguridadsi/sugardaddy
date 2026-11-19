/* Lo apartado de la entrega en el latido (F34): la suma del hecho de cada sensor (puro). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./integridad', () => ({ estadoIntegridad: async () => null }));
const { entregaParaLatido, integridadParaLatido } = await import('./integridad-latido');

describe('entregaParaLatido', () => {
	it('suma lo apartado y cuenta en cuántos sensores', () => {
		expect(
			entregaParaLatido([
				{ 'entrega.apartadas': { valor: 2 } },
				null,
				{ 'entrega.apartadas': { valor: 3 } },
				{ 'otro.hecho': { valor: 1 } }
			])
		).toEqual({ entrega: { apartadas: 5, sensores: 2 } });
	});
	it('sin el hecho, o mal formado, no manda nada', () => {
		expect(entregaParaLatido([undefined, { 'entrega.apartadas': { valor: 'x' } }])).toEqual({});
		expect(entregaParaLatido([{ 'entrega.apartadas': { valor: -1 } }])).toEqual({});
	});
	it('sin comprobación de integridad tampoco', async () => {
		expect(await integridadParaLatido()).toEqual({});
	});
});
