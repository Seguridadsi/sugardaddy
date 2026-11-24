/*
 * La salud de las máquinas y las trampas (salud-maquina.ts): lo que no necesita
 * base de datos. Qué muestra se acepta y qué problemas salen de las muestras.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('./db', () => ({ db: {}, schema: {} }));

const m = await import('./salud-maquina');
type Muestra = import('./salud-maquina').Muestra;

const AHORA = Date.parse('2026-11-24T12:00:00Z');
const GB = 2 ** 30;

function muestra(minutosAtras: number, x: Partial<Muestra> = {}): Muestra {
	return {
		cuando: new Date(AHORA - minutosAtras * 60_000),
		cpu: 10,
		carga1: 0.5,
		cpus: 2,
		memoriaTotal: 4 * GB,
		memoriaLibre: 2 * GB,
		discoTotal: 100 * GB,
		discoLibre: 50 * GB,
		trampas: [],
		...x
	};
}

const serie = (n: number, x: Partial<Muestra> = {}) =>
	Array.from({ length: n }, (_, i) => muestra(i, x));

const problemas = (muestras: Muestra[], nombres = new Map<string, string>()) =>
	m.problemasDeMuestras([{ id: 's1', nombre: 'Oficina', muestras }], nombres, AHORA);

describe('leerMuestra', () => {
	it('acepta la del sensor y pone la hora de la consola', () => {
		const ahora = new Date(AHORA);
		const r = m.leerMuestra(
			{
				v: 1,
				cuando: '1999-01-01T00:00:00Z',
				cpu: 12.5,
				carga1: 0.3,
				cpus: 4,
				memoria: { total: 1000, libre: 400 },
				disco: { total: 2000, libre: 100 },
				trampas: [
					{
						id: 'cowrie-1',
						enMarcha: true,
						estado: 'running',
						reinicios: 2,
						desde: '2026-11-24T10:00:00Z'
					},
					{ id: '../x', enMarcha: true, estado: 'running', reinicios: 0 },
					{ id: 'web', enMarcha: false, estado: 'raro', reinicios: -3 }
				]
			},
			ahora
		);
		expect(r).toMatchObject({
			cuando: ahora,
			cpu: 12.5,
			cpus: 4,
			memoriaTotal: 1000,
			memoriaLibre: 400,
			discoLibre: 100
		});
		expect(r?.trampas).toEqual([
			{
				id: 'cowrie-1',
				enMarcha: true,
				estado: 'running',
				reinicios: 2,
				desde: '2026-11-24T10:00:00Z'
			},
			{ id: 'web', enMarcha: false, estado: 'unknown', reinicios: 0 }
		]);
	});

	it('descarta lo que no cuadra', () => {
		expect(m.leerMuestra(null)).toBeNull();
		expect(m.leerMuestra({ v: 2 })).toBeNull();
		const r = m.leerMuestra({ v: 1, cpu: 400, memoria: { total: 10, libre: 20 }, disco: 'x' });
		expect(r).toMatchObject({ cpu: null, memoriaTotal: null, discoTotal: null, trampas: [] });
	});
});

describe('problemasDeMuestras', () => {
	it('una máquina sana no avisa', () => {
		expect(problemas(serie(31))).toEqual([]);
	});

	it('el disco: casi lleno al 85 %, lleno al 95 %', () => {
		const casi = problemas([muestra(0, { discoLibre: 12 * GB })]);
		expect(casi.map((p) => [p.clave, p.codigo, p.severidad])).toEqual([
			['disco:s1', 'salud.disco-casi-lleno', 'media']
		]);
		const lleno = problemas([muestra(0, { discoLibre: 4 * GB })]);
		expect(lleno.map((p) => [p.codigo, p.severidad])).toEqual([['salud.disco-lleno', 'alta']]);
		expect(lleno[0].titulo).toContain('96 %');
	});

	it('una muestra vieja no dice nada de ahora', () => {
		expect(problemas([muestra(11, { discoLibre: 1 })])).toEqual([]);
	});

	it('la memoria: solo si falta 5 minutos seguidos', () => {
		const poca = { memoriaLibre: 0.05 * 4 * GB };
		expect(problemas(serie(6, poca)).map((p) => p.codigo)).toEqual(['salud.memoria']);
		const una = [muestra(0, poca), ...serie(6).slice(1)];
		expect(problemas(una)).toEqual([]);
		/* Recién llegado: con dos muestras no hay bastante para decirlo. */
		expect(problemas(serie(2, poca))).toEqual([]);
	});

	it('la CPU: solo si pasa del 90 % un cuarto de hora', () => {
		expect(problemas(serie(16, { cpu: 97 })).map((p) => p.codigo)).toEqual(['salud.cpu']);
		const pico = serie(16, { cpu: 97 });
		pico[5] = muestra(5, { cpu: 40 });
		expect(problemas(pico)).toEqual([]);
		expect(problemas(serie(5, { cpu: 99 }))).toEqual([]);
	});

	it('una trampa que se reinicia 3 veces en media hora', () => {
		const nombres = new Map([['t1', 'SSH oficina']]);
		const t = (reinicios: number) => [{ id: 't1', enMarcha: true, estado: 'running', reinicios }];
		const bucle = [
			muestra(0, { trampas: t(7) }),
			muestra(10, { trampas: t(5) }),
			muestra(29, { trampas: t(4) })
		];
		const r = problemas(bucle, nombres);
		expect(r.map((p) => [p.clave, p.codigo, p.sobre])).toEqual([
			[
				'reinicios:t1',
				'salud.trampa-reinicios',
				{ tipo: 'trampa', id: 't1', nombre: 'SSH oficina' }
			]
		]);
		expect(r[0].texto).toContain('3 times');
		const pocos = [muestra(0, { trampas: t(6) }), muestra(29, { trampas: t(4) })];
		expect(problemas(pocos, nombres)).toEqual([]);
		/* Una trampa que no es de esta consola (borrada) no avisa. */
		expect(problemas(bucle)).toEqual([]);
	});
});

describe('la tubería: cola y reloj', () => {
	it('lee la cola y compara el reloj solo si el sensor la manda', () => {
		const ahora = new Date(AHORA);
		const r = m.leerMuestra(
			{
				v: 1,
				cuando: new Date(AHORA + 300_000).toISOString(),
				cola: { pendiente: 4096, tope: 1e6, sinEntregar: 1200, descartando: true },
				trampas: []
			},
			ahora
		);
		expect(r).toMatchObject({
			colaPendiente: 4096,
			colaSinEntregar: 1200,
			colaDescartando: true,
			reloj: 300
		});
		const vieja = m.leerMuestra({ v: 1, cuando: '1999-01-01T00:00:00Z', trampas: [] }, ahora);
		expect(vieja).toMatchObject({ colaPendiente: null, colaDescartando: null, reloj: null });
	});

	it('cola atascada un cuarto de hora y cola que descarta', () => {
		expect(problemas([muestra(0, { colaPendiente: 10, colaSinEntregar: 600 })])).toEqual([]);
		const r = problemas([
			muestra(0, { colaPendiente: 3 * 2 ** 20, colaSinEntregar: 1000, colaDescartando: true })
		]);
		expect(r.map((p) => [p.clave, p.codigo, p.severidad])).toEqual([
			['cola:s1', 'salud.cola-atascada', 'alta'],
			['descarte:s1', 'salud.cola-descartando', 'alta']
		]);
		expect(r[0].texto).toContain('3 MB');
	});

	it('el reloj: más de 2 minutos en 5 muestras seguidas', () => {
		const r = problemas(serie(5, { reloj: -600 }));
		expect(r.map((p) => [p.codigo, p.titulo])).toEqual([
			['salud.reloj', 'The clock of sensor "Oficina" is 10 minutes behind']
		]);
		const una = [muestra(0, { reloj: 0 }), ...serie(5, { reloj: 600 }).slice(1)];
		expect(problemas(una)).toEqual([]);
		expect(problemas(serie(4, { reloj: 600 }))).toEqual([]);
	});
});

describe('trampasCalladas', () => {
	const vieja = new Date(AHORA - 30 * 86_400_000);
	const trampas = [
		{ id: 'web', nombre: 'Web', creado: vieja },
		{ id: 'interna', nombre: 'Interna', creado: vieja },
		{ id: 'nueva', nombre: 'Nueva', creado: new Date(AHORA - 3 * 86_400_000) },
		{ id: 'viva', nombre: 'Viva', creado: vieja },
		{ id: 'rafaga', nombre: 'Ráfaga', creado: vieja }
	];
	it('avisa de la que recibía y ha dejado de recibir', () => {
		const r = m.trampasCalladas(
			[
				{ trampa: 'web', recientes: 0, antes: 300, dias: 7 },
				{ trampa: 'interna', recientes: 0, antes: 3, dias: 3 },
				{ trampa: 'nueva', recientes: 0, antes: 50, dias: 3 },
				{ trampa: 'viva', recientes: 4, antes: 300, dias: 7 },
				/* Una ráfaga de un día (una prueba, un escaneo): no había tráfico que perder. */
				{ trampa: 'rafaga', recientes: 0, antes: 853, dias: 1 }
			],
			trampas,
			AHORA
		);
		expect(r.map((p) => [p.clave, p.codigo, p.severidad])).toEqual([
			['callada:web', 'salud.trampa-callada', 'media']
		]);
		expect(r[0].texto).toContain('300 events');
	});
});

describe('usado', () => {
	it('de 0 a 1, o null si no se sabe', () => {
		expect(m.usado(100, 25)).toBe(0.75);
		expect(m.usado(null, 25)).toBeNull();
		expect(m.usado(0, 0)).toBeNull();
	});
});
