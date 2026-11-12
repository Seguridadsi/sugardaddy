import { describe, expect, it } from 'vitest';
import { almacenDeRetos } from './retos';

describe('el almacén de retos de un solo uso', () => {
	it('un reto vale una vez y nada más', () => {
		const a = almacenDeRetos<{ reto: string }>(10, 1000);
		const id = a.guardar({ reto: 'x' });
		expect(a.tomar(id)?.reto).toBe('x');
		expect(a.tomar(id)).toBeNull();
		expect(a.tomar(undefined)).toBeNull();
	});

	it('caducado no vale, y se limpia al guardar otro', () => {
		let t = 0;
		const a = almacenDeRetos<{ reto: string }>(10, 1000, () => t);
		const viejo = a.guardar({ reto: 'viejo' });
		t = 1001;
		expect(a.tomar(viejo)).toBeNull();
		a.guardar({ reto: 'a' });
		t = 5000;
		a.guardar({ reto: 'b' });
		expect(a.cuantos).toBe(1);
	});

	it('no pasa de su tope: lleno, se va el más antiguo y el recién pedido vale', () => {
		const a = almacenDeRetos<{ n: number }>(3, 60_000);
		const ids = [0, 1, 2, 3, 4].map((n) => a.guardar({ n }));
		expect(a.cuantos).toBe(3);
		expect(a.tomar(ids[0])).toBeNull();
		expect(a.tomar(ids[1])).toBeNull();
		expect(a.tomar(ids[4])?.n).toBe(4);
		expect(a.tomar(ids[2])?.n).toBe(2);
	});
});
