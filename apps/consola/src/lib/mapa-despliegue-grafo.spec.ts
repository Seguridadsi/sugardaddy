import { describe, expect, it } from 'vitest';
import type { TrampaMapa } from './mapa-despliegue';
import {
	CENTRO_SENSOR,
	CENTRO_SITIO,
	HOJA,
	armarGrafo,
	claseDeEstado,
	extremos,
	grafoDeSistema,
	vecinosDe,
	type Grafo,
	type NodoGrafo
} from './mapa-despliegue-grafo';

const TIPOS = ['bases-de-datos', 'ficheros', 'web', 'terminal', 'red', 'industria', 'iot'] as const;

const trampa = (i: number, c: Partial<TrampaMapa> = {}): TrampaMapa => ({
	id: `t${i}`,
	nombre: `Trampa ${i}`,
	modulo: null,
	clase: 'Container',
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
const grafo = (n: number, centro = CENTRO_SENSOR, compacto = false) =>
	armarGrafo({ idCentro: 'c', trampas: trampas(n), centro, compacto });

/* La caja que ocupa cada nodo, con sus etiquetas. */
const caja = (g: Grafo, n: NodoGrafo) => {
	if (n.tipo === 'trampa')
		return {
			l: n.x - HOJA.ancho / 2,
			r: n.x + HOJA.ancho / 2,
			t: n.y - HOJA.circulo / 2,
			b: n.y + HOJA.debajo
		};
	if (n.tipo === 'familia') return { l: n.x - 18, r: n.x + 18, t: n.y - 18, b: n.y + 18 };
	return {
		l: n.x - g.tamano.ancho / 2,
		r: n.x + g.tamano.ancho / 2,
		t: n.y - g.tamano.alto / 2,
		b: n.y + g.tamano.alto / 2
	};
};

const pisados = (g: Grafo) => {
	const r: string[] = [];
	g.nodos.forEach((a, i) => {
		const ca = caja(g, a);
		for (const b of g.nodos.slice(i + 1)) {
			const cb = caja(g, b);
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

/* El ángulo desde el centro: 0 arriba y creciendo en el sentido de las agujas del reloj. */
const angulo = (g: Grafo, n: NodoGrafo) => {
	const a = (Math.atan2(n.x - g.centro.x, g.centro.y - n.y) * 180) / Math.PI;
	return a < 0 ? a + 360 : a;
};

describe('armarGrafo', () => {
	it.each([0, 1, 2, 3, 5, 9, 10, 12, 20, 33, 48, 57, 79, 120])(
		'con %i trampas ningún nodo pisa a otro, y todo cae dentro',
		(n) => {
			const g = grafo(n);
			expect(pisados(g)).toEqual([]);
			for (const x of g.nodos) {
				const c = caja(g, x);
				expect(c.l, x.id).toBeGreaterThanOrEqual(0);
				expect(c.t, x.id).toBeGreaterThanOrEqual(0);
				expect(c.r, x.id).toBeLessThanOrEqual(g.ancho);
				expect(c.b, x.id).toBeLessThanOrEqual(g.alto);
			}
		}
	);

	it.each([1, 2, 3, 4, 5, 6, 9, 10, 30])('un sitio compacto con %i trampas tampoco', (n) => {
		expect(pisados(grafo(n, CENTRO_SITIO, true))).toEqual([]);
	});

	it('cada trampa sale una sola vez', () => {
		const ids = grafo(48)
			.nodos.filter((n) => n.tipo === 'trampa')
			.map((n) => n.id);
		expect(ids).toHaveLength(48);
		expect(new Set(ids).size).toBe(48);
	});

	it('toda arista une nodos que existen', () => {
		const g = grafo(30);
		const ids = new Set(g.nodos.map((n) => n.id));
		for (const a of g.aristas) {
			expect(ids.has(a.de), a.de).toBe(true);
			expect(ids.has(a.a), a.a).toBe(true);
		}
	});

	it('deja libre la entrada de arriba, por donde llega la línea', () => {
		for (const n of [3, 9, 12, 48, 79]) {
			const g = grafo(n);
			const estorba = g.nodos.filter((x) => {
				if (x.tipo === 'centro') return false;
				const c = caja(g, x);
				return c.l < g.centro.x && g.centro.x < c.r && c.t < g.centro.y;
			});
			expect(estorba.map((x) => x.id)).toEqual([]);
		}
	});

	it('es siempre igual con los mismos datos', () => {
		expect(grafo(25)).toEqual(grafo(25));
	});

	it('con pocas trampas, una estrella: todas unidas al sitio', () => {
		const g = grafo(6);
		expect(g.nodos.some((n) => n.tipo === 'familia')).toBe(false);
		expect(g.aristas.every((a) => a.de === 'c')).toBe(true);
	});

	it('un sitio pequeño queda compacto: el sitio arriba y sus trampas debajo', () => {
		const g = grafo(3, CENTRO_SITIO, true);
		for (const n of g.nodos.filter((x) => x.tipo === 'trampa'))
			expect(n.y, n.id).toBeGreaterThan(g.centro.y);
		expect(g.ancho).toBeLessThan(grafo(3).ancho);
	});

	it('con más, agrupadas por tipo: el grupo cuelga del sitio y las trampas del grupo', () => {
		const g = grafo(21);
		const familias = g.nodos.filter((n) => n.tipo === 'familia');
		expect(familias).toHaveLength(TIPOS.length);
		for (const f of familias) {
			expect(g.aristas.some((a) => a.de === 'c' && a.a === f.id)).toBe(true);
			expect(g.aristas.filter((a) => a.de === f.id)).toHaveLength(3);
		}
	});

	it('cada tipo tiene su sector: sus trampas no se mezclan con las de otro', () => {
		for (const n of [12, 21, 48, 79]) {
			const g = grafo(n);
			const porAngulo = g.nodos
				.filter((x) => x.tipo === 'trampa')
				.toSorted((a, b) => angulo(g, a) - angulo(g, b))
				.map((x) => (x.tipo === 'trampa' ? x.trampa.pictograma : null));
			/* Dando la vuelta, cada tipo aparece en un solo tramo seguido. */
			const tramos = porAngulo.filter((t, i) => i === 0 || t !== porAngulo[i - 1]);
			expect(new Set(tramos).size, `${n} trampas`).toBe(tramos.length);
		}
	});

	it('con muchos tipos, cada grupo con varias trampas lleva su nombre', () => {
		const lista = trampas(48).map((t, i) => ({
			...t,
			pictograma: (
				[
					'bases-de-datos',
					'ficheros',
					'web',
					'terminal',
					'red',
					'industria',
					'iot',
					'directorio',
					'contenedores',
					'sanidad',
					'ia',
					'codigo'
				] as const
			)[i % 12]
		}));
		const g = armarGrafo({ idCentro: 'c', trampas: lista, centro: CENTRO_SENSOR });
		const familias = g.nodos.filter((n) => n.tipo === 'familia');
		expect(familias).toHaveLength(12);
		expect(familias.filter((f) => f.tipo === 'familia' && f.conNombre)).toHaveLength(12);
	});

	it('un tipo con una sola trampa no tiene grupo: va directa al sitio', () => {
		const lista: TrampaMapa[] = trampas(10).map((t) => ({ ...t, pictograma: 'web' }));
		lista.push(trampa(50, { pictograma: 'sanidad' }));
		const g = armarGrafo({ idCentro: 'c', trampas: lista, centro: CENTRO_SENSOR });
		expect(g.nodos.filter((n) => n.tipo === 'familia').map((n) => n.id)).toEqual(['f:c:web']);
		expect(g.aristas.some((a) => a.de === 'c' && a.a === 't:t50')).toBe(true);
	});

	it('una trampa sin tipo también se coloca', () => {
		const g = armarGrafo({
			idCentro: 'c',
			trampas: trampas(14).map((t) => ({ ...t, pictograma: null })),
			centro: CENTRO_SENSOR
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

	it('lo sembrado en el sitio que apunta a otra trampa suya se une con ella, diciendo cómo', () => {
		const g = armarGrafo({
			idCentro: 'c',
			centro: CENTRO_SENSOR,
			trampas: [
				trampa(1, { id: 'rec' }),
				trampa(2, {
					id: 'kp',
					objetivo: 'rec',
					ruta: { texto: 'Windows audit, to', destino: '10.0.0.1:8088/tcp', rele: false }
				})
			]
		});
		expect(g.aristas.find((a) => a.relacion)).toEqual({
			de: 't:kp',
			a: 't:rec',
			clase: 'senal',
			relacion: { texto: 'Windows audit', destino: '10.0.0.1:8088/tcp' }
		});
	});

	it('si la señal va a otro sitio, no se dibuja una línea a nada de este', () => {
		const g = armarGrafo({
			idCentro: 'c',
			centro: CENTRO_SENSOR,
			trampas: [trampa(1, { objetivo: 'de-otro-sitio' })]
		});
		expect(g.aristas.filter((a) => a.relacion)).toEqual([]);
	});

	it('un sitio sin trampas es solo su centro', () => {
		const g = grafo(0);
		expect(g.nodos.map((n) => n.id)).toEqual(['c']);
		expect(g.ancho).toBeGreaterThanOrEqual(CENTRO_SENSOR.ancho);
		expect(g.alto).toBeGreaterThanOrEqual(CENTRO_SENSOR.alto);
	});

	it('el grafo de un sitio sin sensor usa su id, para que su detalle lo encuentre', () => {
		const g = grafoDeSistema({
			id: 'dc01',
			nombre: 'DC01',
			tipo: 'Máquina',
			icono: 'maquina',
			direccion: '10.0.0.4',
			faltaDireccion: false,
			plataforma: null,
			ruta: null,
			linea: 'senal',
			trampas: [trampa(1, { pictograma: 'ficheros' })]
		});
		expect(g.nodos[0].id).toBe('s:dc01');
		expect(g.aristas[0]).toMatchObject({ de: 's:dc01', a: 't:t1' });
	});
});

describe('vecinosDe', () => {
	it('da el nodo y los unidos a él, en los dos sentidos', () => {
		const g = armarGrafo({
			idCentro: 'c',
			centro: CENTRO_SENSOR,
			trampas: [trampa(1, { id: 'rec' }), trampa(2, { id: 'kp', objetivo: 'rec' })]
		});
		expect([...vecinosDe(g, 't:rec')].toSorted()).toEqual(['c', 't:kp', 't:rec']);
		expect([...vecinosDe(g, 'c')].toSorted()).toEqual(['c', 't:kp', 't:rec']);
	});
});

describe('extremos', () => {
	it('la señal empieza y acaba fuera de los dos nodos, para que se vea su flecha', () => {
		const g = armarGrafo({
			idCentro: 'c',
			centro: CENTRO_SENSOR,
			trampas: [trampa(1, { id: 'rec' }), trampa(2, { id: 'kp', objetivo: 'rec' })]
		});
		const a = g.aristas.find((x) => x.relacion)!;
		const r = extremos(g, a)!;
		const hacia = nodo(g, 't:rec');
		expect(Math.hypot(r.hasta.x - hacia.x, r.hasta.y - hacia.y)).toBeGreaterThan(HOJA.circulo / 2);
	});

	it('sin alguno de los dos nodos no hay línea', () => {
		expect(extremos(grafo(0), { de: 'c', a: 'nadie', clase: 'senal' })).toBeNull();
	});
});
