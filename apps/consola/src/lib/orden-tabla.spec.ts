import { describe, expect, it } from 'vitest';
import { alternar, ordenar, type Clave } from './orden-tabla';

type Fila = { nombre: string; sensor: string; eventos: number };
type Col = 'nombre' | 'sensor' | 'eventos';

const filas: Fila[] = [
	{ nombre: 'ssh-10', sensor: 'madrid', eventos: 0 },
	{ nombre: 'ssh-2', sensor: 'Bilbao', eventos: 7 },
	{ nombre: 'web', sensor: 'madrid', eventos: 7 },
	{ nombre: 'dns', sensor: 'Bilbao', eventos: 1 }
];
const valores = {
	nombre: (f: Fila) => f.nombre,
	sensor: (f: Fila) => f.sensor,
	eventos: (f: Fila) => f.eventos
};
const nombres = (orden: Clave<Col>[]) => ordenar(filas, orden, valores).map((f) => f.nombre);

describe('ordenar', () => {
	it('sin orden deja las filas como venían, en una lista nueva', () => {
		const r = ordenar(filas, [], valores);
		expect(r).toEqual(filas);
		expect(r).not.toBe(filas);
	});

	it('ordena texto sin mirar mayúsculas y con los números como números', () => {
		expect(nombres([{ columna: 'nombre', sentido: 'asc' }])).toEqual([
			'dns',
			'ssh-2',
			'ssh-10',
			'web'
		]);
	});

	it('la segunda columna deshace los empates de la primera', () => {
		expect(
			nombres([
				{ columna: 'sensor', sentido: 'asc' },
				{ columna: 'eventos', sentido: 'desc' }
			])
		).toEqual(['ssh-2', 'dns', 'web', 'ssh-10']);
	});

	it('no toca la lista que recibe', () => {
		const antes = filas.map((f) => f.nombre);
		nombres([{ columna: 'eventos', sentido: 'desc' }]);
		expect(filas.map((f) => f.nombre)).toEqual(antes);
	});
});

describe('alternar', () => {
	it('un clic solo: ascendente, descendente y sin orden', () => {
		let o = alternar<Col>([], 'sensor', false);
		expect(o).toEqual([{ columna: 'sensor', sentido: 'asc' }]);
		o = alternar(o, 'sensor', false);
		expect(o).toEqual([{ columna: 'sensor', sentido: 'desc' }]);
		expect(alternar(o, 'sensor', false)).toEqual([]);
	});

	it('un clic solo en otra columna sustituye a las que había', () => {
		const o: Clave<Col>[] = [
			{ columna: 'sensor', sentido: 'asc' },
			{ columna: 'eventos', sentido: 'desc' }
		];
		expect(alternar(o, 'nombre', false)).toEqual([{ columna: 'nombre', sentido: 'asc' }]);
	});

	it('añadiendo, suma la columna al final y respeta su sitio al cambiarla', () => {
		let o = alternar<Col>([{ columna: 'sensor', sentido: 'asc' }], 'eventos', true);
		expect(o).toEqual([
			{ columna: 'sensor', sentido: 'asc' },
			{ columna: 'eventos', sentido: 'asc' }
		]);
		o = alternar(o, 'sensor', true);
		expect(o).toEqual([
			{ columna: 'sensor', sentido: 'desc' },
			{ columna: 'eventos', sentido: 'asc' }
		]);
		expect(alternar(o, 'sensor', true)).toEqual([{ columna: 'eventos', sentido: 'asc' }]);
	});
});
