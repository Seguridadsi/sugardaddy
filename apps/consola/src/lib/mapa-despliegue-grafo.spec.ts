import { describe, expect, it } from 'vitest';
import type { SistemaMapa, TrampaMapa } from './mapa-despliegue';
import {
	CENTRO,
	HOJA,
	SISTEMA,
	armarGrafo,
	claseDeEstado,
	extremos,
	vecinosDe,
	type Grafo,
	type NodoGrafo
} from './mapa-despliegue-grafo';

const TIPOS = ['bases-de-datos', 'ficheros', 'web', 'terminal', 'red', 'industria', 'iot'] as const;

const trampa = (i: number, c: Partial<TrampaMapa> = {}): TrampaMapa => ({
	id: `t${i}`,
	nombre: `Trampa ${i}`,
	modulo: null,
	clase: 'Contenedor',
	estado: 'comprobada',
	etiqueta: 'Comprobada',
	motivo: null,
	problema: false,
	eventos: 0,
	puertos: [{ servicio: 'SSH', puerto: `${i}/tcp`, escuchaEn: null }],
	conIpPropia: false,
	ipPropia: null,
	ubicacion: null,
	ruta: null,
	recibeDe: [],
	objetivo: null,
	pictograma: TIPOS[i % TIPOS.length],
	procedencia: null,
	...c
});
const trampas = (n: number) => Array.from({ length: n }, (_, i) => trampa(i));
const sistema = (id: string, c: Partial<SistemaMapa> = {}): SistemaMapa => ({
	id,
	nombre: id,
	tipo: 'Máquina',
	icono: 'maquina',
	direccion: '10.0.0.9',
	faltaDireccion: false,
	plataforma: null,
	ruta: null,
	linea: 'senal',
	trampas: [],
	...c
});

/* La caja que ocupa cada nodo, con sus etiquetas. */
const caja = (n: NodoGrafo) => {
	if (n.tipo === 'trampa')
		return {
			l: n.x - HOJA.ancho / 2,
			r: n.x + HOJA.ancho / 2,
			t: n.y - HOJA.circulo / 2,
			b: n.y + HOJA.debajo
		};
	if (n.tipo === 'familia') return { l: n.x - 18, r: n.x + 18, t: n.y - 18, b: n.y + 18 };
	const c = n.tipo === 'centro' ? CENTRO : SISTEMA;
	return {
		l: n.x - c.ancho / 2,
		r: n.x + c.ancho / 2,
		t: n.y - c.alto / 2,
		b: n.y + c.alto / 2
	};
};

const pisados = (g: Grafo) => {
	const r: string[] = [];
	g.nodos.forEach((a, i) => {
		const ca = caja(a);
		for (const b of g.nodos.slice(i + 1)) {
			const cb = caja(b);
			if (ca.l < cb.r && cb.l < ca.r && ca.t < cb.b && cb.t < ca.b) r.push(`${a.id} / ${b.id}`);
		}
	});
	return r;
};

const nodo = (g: Grafo, id: string) => {
	const n = g.nodos.find((x) => x.id === id);
	if (!n) throw new Error(`no está: ${id}`);
	return n;
};

describe('armarGrafo', () => {
	it.each([0, 1, 2, 3, 5, 9, 10, 12, 20, 33, 48, 57, 79, 120])(
		'con %i trampas ningún nodo pisa a otro, y todo cae dentro',
		(n) => {
			const g = armarGrafo({ idCentro: 'c', trampas: trampas(n), sistemas: [] });
			expect(pisados(g)).toEqual([]);
			for (const x of g.nodos) {
				const c = caja(x);
				expect(c.l, x.id).toBeGreaterThanOrEqual(0);
				expect(c.t, x.id).toBeGreaterThanOrEqual(0);
				expect(c.r, x.id).toBeLessThanOrEqual(g.ancho);
				expect(c.b, x.id).toBeLessThanOrEqual(g.alto);
			}
		}
	);

	it('cada trampa sale una sola vez', () => {
		const g = armarGrafo({ idCentro: 'c', trampas: trampas(48), sistemas: [] });
		const ids = g.nodos.filter((n) => n.tipo === 'trampa').map((n) => n.id);
		expect(ids).toHaveLength(48);
		expect(new Set(ids).size).toBe(48);
	});

	it('toda arista une nodos que existen', () => {
		const g = armarGrafo({
			idCentro: 'c',
			trampas: trampas(30),
			sistemas: [sistema('a', { trampas: [trampa(100, { objetivo: 't1' })] })]
		});
		const ids = new Set(g.nodos.map((n) => n.id));
		for (const a of g.aristas) {
			expect(ids.has(a.de), a.de).toBe(true);
			expect(ids.has(a.a), a.a).toBe(true);
		}
	});

	it('deja libre la entrada de arriba, por donde llega la línea de la consola', () => {
		for (const n of [3, 9, 12, 48, 79]) {
			const g = armarGrafo({ idCentro: 'c', trampas: trampas(n), sistemas: [] });
			const cx = g.centro!.x;
			const cy = g.centro!.y;
			const estorba = g.nodos.filter((x) => {
				if (x.tipo === 'centro') return false;
				const c = caja(x);
				return c.l < cx && cx < c.r && c.t < cy;
			});
			expect(estorba.map((x) => x.id)).toEqual([]);
		}
	});

	it('es siempre igual con los mismos datos', () => {
		const v = { idCentro: 'c', trampas: trampas(25), sistemas: [sistema('a')] };
		expect(armarGrafo(v)).toEqual(armarGrafo(v));
	});

	it('con pocas trampas, una estrella: todas unidas al sensor', () => {
		const g = armarGrafo({ idCentro: 'c', trampas: trampas(6), sistemas: [] });
		expect(g.nodos.some((n) => n.tipo === 'familia')).toBe(false);
		expect(g.aristas.every((a) => a.de === 'c')).toBe(true);
	});

	it('con más, agrupadas por tipo: el grupo cuelga del sensor y las trampas del grupo', () => {
		const g = armarGrafo({ idCentro: 'c', trampas: trampas(21), sistemas: [] });
		const familias = g.nodos.filter((n) => n.tipo === 'familia');
		expect(familias).toHaveLength(TIPOS.length);
		for (const f of familias) {
			expect(g.aristas.some((a) => a.de === 'c' && a.a === f.id)).toBe(true);
			expect(g.aristas.filter((a) => a.de === f.id)).toHaveLength(3);
		}
	});

	it('un tipo con una sola trampa no tiene grupo: va directa al sensor', () => {
		const lista: TrampaMapa[] = trampas(10).map((t) => ({ ...t, pictograma: 'web' }));
		lista.push(trampa(50, { pictograma: 'sanidad' }));
		const g = armarGrafo({ idCentro: 'c', trampas: lista, sistemas: [] });
		expect(g.nodos.filter((n) => n.tipo === 'familia').map((n) => n.id)).toEqual(['f:c:web']);
		expect(g.aristas.some((a) => a.de === 'c' && a.a === 't:t50')).toBe(true);
	});

	it('una trampa sin tipo también se coloca', () => {
		const g = armarGrafo({
			idCentro: 'c',
			trampas: trampas(14).map((t) => ({ ...t, pictograma: null })),
			sistemas: []
		});
		expect(g.nodos.filter((n) => n.tipo === 'trampa')).toHaveLength(14);
		expect(pisados(g)).toEqual([]);
	});

	it('la línea de cada trampa es del color de su estado', () => {
		expect(claseDeEstado({ estado: 'comprobada' })).toBe('ok');
		expect(claseDeEstado({ estado: 'colocada' })).toBe('pendiente');
		expect(claseDeEstado({ estado: 'degradada' })).toBe('aviso');
		expect(claseDeEstado({ estado: 'por-colocar' })).toBe('aviso');
		expect(claseDeEstado({ estado: 'sin-contacto' })).toBe('mal');
		expect(claseDeEstado({ estado: 'parada' })).toBe('estructura');
	});

	describe('los sistemas sin sensor', () => {
		const receptor = trampa(1, { id: 'rec' });
		const kp = trampa(2, {
			id: 'kp',
			objetivo: 'rec',
			ruta: { texto: 'Auditoría de Windows, hacia', destino: '10.0.0.1:8088/tcp', rele: false }
		});

		it('van debajo y se unen a la trampa que recibe su señal, diciendo cómo llega', () => {
			const g = armarGrafo({
				idCentro: 'c',
				trampas: [receptor, ...trampas(4)],
				sistemas: [sistema('fs', { trampas: [kp] })]
			});
			const relacion = g.aristas.find((a) => a.relacion);
			expect(relacion).toEqual({
				de: 's:fs',
				a: 't:rec',
				clase: 'senal',
				relacion: { texto: 'Auditoría de Windows', destino: '10.0.0.1:8088/tcp' }
			});
			expect(nodo(g, 's:fs').y).toBeGreaterThan(g.centro!.y);
			expect(pisados(g)).toEqual([]);
		});

		it('la trampa que recibe señal se coloca abajo, cerca de quien le llega', () => {
			const g = armarGrafo({
				idCentro: 'c',
				trampas: [receptor, ...trampas(8)],
				sistemas: [sistema('fs', { trampas: [kp] })]
			});
			expect(nodo(g, 't:rec').y).toBeGreaterThan(g.centro!.y);
		});

		it('si su señal va a otro sensor, o no se sabe, se unen a su centro', () => {
			const g = armarGrafo({
				idCentro: 'c',
				trampas: trampas(2),
				sistemas: [
					sistema('a', { trampas: [trampa(10, { objetivo: 'de-otro-sensor' })] }),
					sistema('b')
				]
			});
			expect(g.aristas.filter((a) => a.relacion).map((a) => [a.de, a.a])).toEqual([
				['s:a', 'c'],
				['s:b', 'c']
			]);
		});

		it('una línea por destino, aunque varias trampas vayan al mismo', () => {
			const g = armarGrafo({
				idCentro: 'c',
				trampas: [receptor],
				sistemas: [
					sistema('fs', {
						trampas: [
							trampa(10, { objetivo: 'rec' }),
							trampa(11, { objetivo: 'rec' }),
							trampa(12, { objetivo: 'otra' })
						]
					})
				]
			});
			expect(g.aristas.filter((a) => a.relacion).map((a) => a.a)).toEqual(['t:rec', 'c']);
		});

		it('lo que llega por el relé se distingue', () => {
			const g = armarGrafo({
				idCentro: 'c',
				trampas: [],
				sistemas: [sistema('nube', { linea: 'rele', trampas: [trampa(1)] })]
			});
			expect(g.aristas.find((a) => a.relacion)?.clase).toBe('rele');
		});

		it('sin centro no hay líneas de señal: son los que aún no tienen trampas', () => {
			const g = armarGrafo({ idCentro: null, trampas: [], sistemas: [sistema('a'), sistema('b')] });
			expect(g.centro).toBeNull();
			expect(g.aristas).toEqual([]);
			expect(g.nodos.map((n) => n.id)).toEqual(['s:a', 's:b']);
		});

		it.each([1, 3, 4, 8, 15, 30])('con %i trampas un sistema no pisa nada', (n) => {
			const g = armarGrafo({
				idCentro: 'c',
				trampas: trampas(12),
				sistemas: [
					sistema('a', {
						trampas: Array.from({ length: n }, (_, i) => trampa(200 + i))
					}),
					sistema('b', { trampas: [trampa(900)] })
				]
			});
			expect(pisados(g)).toEqual([]);
		});

		it('muchos sistemas pasan a otra fila en lugar de hacer el grafo interminable', () => {
			const lista = Array.from({ length: 12 }, (_, i) =>
				sistema(`s${i}`, { trampas: [trampa(300 + i)] })
			);
			const g = armarGrafo({ idCentro: 'c', trampas: trampas(3), sistemas: lista });
			expect(g.ancho).toBeLessThan(900);
			expect(pisados(g)).toEqual([]);
		});
	});

	it('sobra sitio para un centro solo, sin trampas', () => {
		const g = armarGrafo({ idCentro: 'c', trampas: [], sistemas: [] });
		expect(g.nodos.map((n) => n.id)).toEqual(['c']);
		expect(g.ancho).toBeGreaterThanOrEqual(CENTRO.ancho);
		expect(g.alto).toBeGreaterThanOrEqual(CENTRO.alto);
	});
});

describe('vecinosDe', () => {
	it('da el nodo y los unidos a él, en los dos sentidos', () => {
		const g = armarGrafo({
			idCentro: 'c',
			trampas: [trampa(1, { id: 'rec' })],
			sistemas: [sistema('fs', { trampas: [trampa(2, { id: 'kp', objetivo: 'rec' })] })]
		});
		expect([...vecinosDe(g, 't:rec')].toSorted()).toEqual(['c', 's:fs', 't:rec']);
		expect([...vecinosDe(g, 's:fs')].toSorted()).toEqual(['s:fs', 't:kp', 't:rec']);
	});
});

describe('extremos', () => {
	it('la señal empieza y acaba fuera de los dos nodos, para que se vea su flecha', () => {
		const g = armarGrafo({
			idCentro: 'c',
			trampas: [trampa(1, { id: 'rec' })],
			sistemas: [sistema('fs', { trampas: [trampa(2, { id: 'kp', objetivo: 'rec' })] })]
		});
		const a = g.aristas.find((x) => x.relacion)!;
		const r = extremos(g, a)!;
		const hacia = nodo(g, 't:rec');
		const de = nodo(g, 's:fs');
		expect(Math.hypot(r.hasta.x - hacia.x, r.hasta.y - hacia.y)).toBeGreaterThan(HOJA.circulo / 2);
		/* Llega por debajo: acaba bajo las etiquetas de la trampa, sin montarse en ellas. */
		expect(r.hasta.y - hacia.y).toBeGreaterThan(HOJA.debajo / 2);
		expect(Math.abs(r.desde.y - de.y)).toBeGreaterThan(SISTEMA.alto / 2);
	});

	it('sin alguno de los dos nodos no hay línea', () => {
		const g = armarGrafo({ idCentro: 'c', trampas: [], sistemas: [] });
		expect(extremos(g, { de: 'c', a: 'nadie', clase: 'senal' })).toBeNull();
	});
});
