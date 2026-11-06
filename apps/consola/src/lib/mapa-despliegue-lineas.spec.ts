import { describe, expect, it } from 'vitest';
import {
	trazarFilas,
	trazarLineas,
	type Caja,
	type RamaEntrada,
	type RamaFila
} from './mapa-despliegue-lineas';

const consola: Caja = { l: 400, t: 0, r: 800, b: 100 };
const zona = (l: number, t = 200): Caja => ({ l, t, r: l + 400, b: t + 600 });
const tarjeta = (l: number, t = 280): Caja => ({ l: l + 14, t, r: l + 386, b: t + 200 });
const rama = (c: Partial<RamaEntrada> & { l?: number } = {}): RamaEntrada => ({
	caja: tarjeta(c.l ?? 0),
	zona: zona(c.l ?? 0),
	clase: 'ok',
	directa: true,
	pildora: null,
	...c
});

const puntos = (d: string) =>
	d
		.slice(1)
		.split(' L')
		.map((p) => p.split(' ').map(Number));

describe('trazarLineas', () => {
	it('sin sensores no pinta barra ni tronco', () => {
		expect(trazarLineas({ consola, ramas: [], hijos: [], hueco: 48 })).toEqual({
			trazos: [],
			flechas: [],
			pildoras: []
		});
	});

	it('una rama directa baja a su tarjeta por la derecha de la red, sin pisar el título', () => {
		const { trazos, flechas } = trazarLineas({ consola, ramas: [rama()], hijos: [], hueco: 48 });
		const [tronco, barra, r] = trazos;
		expect(puntos(tronco.d)).toEqual([
			[600, 100],
			[600, 122]
		]);
		expect(puntos(r.d)).toEqual([
			[336, 122],
			[336, 280]
		]);
		/* La barra llega de la consola a la rama. */
		expect(puntos(barra.d)).toEqual([
			[336, 122],
			[600, 122]
		]);
		expect(flechas).toHaveLength(2);
	});

	it('los demás bajan por el pasillo y entran por el lado', () => {
		const { trazos } = trazarLineas({
			consola,
			ramas: [rama({ directa: false, clase: 'ok' })],
			hijos: [],
			hueco: 48
		});
		expect(puntos(trazos[2].d)).toEqual([
			[424, 122],
			[424, 324],
			[386, 324]
		]);
	});

	it('un sensor caído va en su carril: no lo tapa otro que baje por el mismo pasillo', () => {
		const { trazos } = trazarLineas({
			consola,
			ramas: [rama({ directa: false }), rama({ directa: false, clase: 'mal' })],
			hijos: [],
			hueco: 48
		});
		expect(puntos(trazos[2].d)[0][0]).not.toBe(puntos(trazos[3].d)[0][0]);
		expect(trazos[3].clase).toBe('mal');
	});

	it('la barra es de lo que funciona; si todo está caído, lo dice', () => {
		const clase = (ramas: RamaEntrada[]) =>
			trazarLineas({ consola, ramas, hijos: [], hueco: 48 }).trazos[0].clase;
		expect(clase([rama({ clase: 'mal' }), rama({ l: 500 })])).toBe('ok');
		expect(clase([rama({ clase: 'mal' })])).toBe('mal');
		expect(clase([rama({ clase: 'rele' })])).toBe('rele');
	});

	it('la píldora va entre la barra y la red, solo en las directas que la llevan', () => {
		const { pildoras } = trazarLineas({
			consola,
			ramas: [
				rama({ pildora: '443/tcp' }),
				rama({ l: 500 }),
				rama({ directa: false, pildora: 'x' })
			],
			hijos: [],
			hueco: 48
		});
		expect(pildoras).toHaveLength(1);
		expect(pildoras[0].texto).toBe('443/tcp');
		expect(pildoras[0].y).toBeGreaterThan(122);
		expect(pildoras[0].y).toBeLessThan(200);
	});

	it('los sistemas cuelgan de un raíl a la izquierda, con una sola flecha por sensor', () => {
		const padre = tarjeta(0);
		const { trazos, flechas } = trazarLineas({
			consola,
			ramas: [],
			hijos: [
				{ padre, hijo: { l: 40, t: 520, r: 386, b: 700 }, clase: 'senal' },
				{ padre, hijo: { l: 40, t: 720, r: 386, b: 900 }, clase: 'senal' }
			],
			hueco: 48
		});
		expect(puntos(trazos[0].d)).toEqual([
			[22, 480],
			[22, 544],
			[40, 544]
		]);
		expect(puntos(trazos[1].d)[2]).toEqual([40, 744]);
		expect(flechas).toHaveLength(1);
	});

	it('lo que llega por el relé se pinta encima de lo gris', () => {
		const padre = tarjeta(0);
		const { trazos } = trazarLineas({
			consola,
			ramas: [],
			hijos: [
				{ padre, hijo: { l: 40, t: 520, r: 386, b: 700 }, clase: 'rele' },
				{ padre, hijo: { l: 40, t: 720, r: 386, b: 900 }, clase: 'senal' }
			],
			hueco: 48
		});
		expect(trazos.map((t) => t.clase)).toEqual(['senal', 'rele']);
	});
});

describe('trazarFilas', () => {
	const consola: Caja = { l: 400, t: 0, r: 800, b: 100 };
	const rama = (c: Partial<RamaFila> & { x: number; t?: number }): RamaFila => ({
		caja: { l: c.x - 100, r: c.x + 100, t: (c.t ?? 200) + 200, b: (c.t ?? 200) + 300 },
		cuadro: { l: c.x - 300, r: c.x + 300, t: (c.t ?? 200) + 60, b: (c.t ?? 200) + 600 },
		zona: { l: c.x - 320, r: c.x + 320, t: c.t ?? 200, b: (c.t ?? 200) + 640 },
		clase: 'ok',
		pildora: null,
		primeraDeZona: true,
		...c
	});

	it('sin nada no pinta nada', () => {
		expect(trazarFilas({ consola, ramas: [] })).toEqual({ trazos: [], flechas: [], pildoras: [] });
	});

	it('una sola fila: barra sobre las redes y cada sensor baja hasta su nodo, sin tronco', () => {
		const { trazos } = trazarFilas({ consola, ramas: [rama({ x: 400 }), rama({ x: 1000 })] });
		expect(trazos.map((t) => puntos(t.d))).toEqual([
			[
				[600, 100],
				[600, 156]
			],
			[
				[400, 156],
				[1000, 156]
			],
			[
				[400, 156],
				[400, 400]
			],
			[
				[1000, 156],
				[1000, 400]
			]
		]);
	});

	it('varias filas: un tronco a la izquierda une sus barras, por fuera de las redes', () => {
		const { trazos } = trazarFilas({
			consola,
			ramas: [rama({ x: 400 }), rama({ x: 400, t: 1000 })]
		});
		const tronco = puntos(trazos[1].d);
		expect(tronco).toEqual([
			[64, 156],
			[64, 956]
		]);
		/* A la izquierda de todas las redes. */
		expect(tronco[0][0]).toBeLessThan(80);
		/* La barra de la segunda fila cae en el hueco entre filas, encima de su red. */
		expect(puntos(trazos[3].d)[0][1]).toBe(956);
	});

	it('un segundo grafo en la misma red sale por su margen y no cruza el de arriba', () => {
		const { trazos } = trazarFilas({
			consola,
			ramas: [rama({ x: 400, primeraDeZona: false })]
		});
		expect(puntos(trazos[trazos.length - 1].d)).toEqual([
			[86, 156],
			[86, 254],
			[400, 254],
			[400, 400]
		]);
	});

	it('la píldora va encima de su red y un sensor caído se ve en su línea', () => {
		const { pildoras, trazos } = trazarFilas({
			consola,
			ramas: [rama({ x: 400, pildora: '443/tcp', clase: 'mal' })]
		});
		expect(pildoras).toEqual([{ x: 400, y: 180, texto: '443/tcp', clase: 'mal' }]);
		expect(trazos[trazos.length - 1].clase).toBe('mal');
	});
});
