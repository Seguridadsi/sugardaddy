/*
 * Lo que cubre una ventana de mantenimiento y cómo se dice, sin base de datos.
 * mantenimiento-base.spec.ts lo prueba de punta a punta contra Postgres.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('./db', () => ({ db: {}, schema: {} }));
vi.mock('./mantenimiento-avisos', () => ({ avisarMantenimiento: () => {} }));
vi.mock('./zona-documentos', () => ({ zonaDocumentos: async () => 'Europe/Madrid' }));

const { cobertura, textoAlcance, textoResumen } = await import('./mantenimiento');

type V = Parameters<typeof cobertura>[0][number];
const ventana = (id: string, alcance: V['alcance'], objetivos: string[] = []) =>
	({ id, alcance, objetivos }) as V;

const DESTINOS = [
	{ id: 'maquina-a', sensor: 'sa' },
	{ id: 'fileserver', sensor: null }
];
const TRAMPAS = [
	{ id: 't-a1', sensor: 'sa', destino: null },
	{ id: 't-a2', sensor: 'sa', destino: 'maquina-a' },
	/* Puesta por el sensor sa en otra máquina: no es del sitio «maquina-a». */
	{ id: 't-fs', sensor: 'sa', destino: 'fileserver' },
	{ id: 't-b', sensor: 'sb', destino: null }
];
const SENSORES = ['sa', 'sb'];

describe('cobertura', () => {
	it('sin ventanas no cubre nada', () => {
		const c = cobertura([], DESTINOS, TRAMPAS, SENSORES);
		expect(c.nodo).toBe(false);
		expect(c.sensores.size + c.trampas.size).toBe(0);
	});

	it('todo el nodo: todos los sensores y todas las trampas', () => {
		const c = cobertura([ventana('v1', 'nodo')], DESTINOS, TRAMPAS, SENSORES);
		expect(c.nodo).toBe(true);
		expect([...c.sensores.keys()].sort()).toEqual(['sa', 'sb']);
		expect([...c.trampas.keys()].sort()).toEqual(['t-a1', 't-a2', 't-b', 't-fs']);
	});

	it('unos sensores: ellos y sus trampas, estén donde estén', () => {
		const c = cobertura([ventana('v1', 'sensores', ['sb'])], DESTINOS, TRAMPAS, SENSORES);
		expect([...c.sensores.keys()]).toEqual(['sb']);
		expect([...c.trampas.keys()]).toEqual(['t-b']);
	});

	it('un sitio con sensor: su sensor y lo puesto en esa máquina, no lo que pone fuera', () => {
		const c = cobertura([ventana('v1', 'sitios', ['maquina-a'])], DESTINOS, TRAMPAS, SENSORES);
		expect([...c.sensores.keys()]).toEqual(['sa']);
		expect([...c.trampas.keys()].sort()).toEqual(['t-a1', 't-a2']);
	});

	it('un sitio sin sensor (un servidor de ficheros): solo sus trampas', () => {
		const c = cobertura([ventana('v1', 'sitios', ['fileserver'])], DESTINOS, TRAMPAS, SENSORES);
		expect(c.sensores.size).toBe(0);
		expect([...c.trampas.keys()]).toEqual(['t-fs']);
	});

	it('cada sensor y cada trampa dicen qué ventanas los cubren', () => {
		const c = cobertura(
			[ventana('v1', 'sensores', ['sa']), ventana('v2', 'sitios', ['maquina-a'])],
			DESTINOS,
			TRAMPAS,
			SENSORES
		);
		expect(c.sensores.get('sa')).toEqual(['v1', 'v2']);
		expect(c.trampas.get('t-fs')).toEqual(['v1']);
	});
});

describe('textos', () => {
	it('dice qué cubre', () => {
		expect(textoAlcance({ alcance: 'nodo', objetivos: [] })).toBe('the whole node');
		expect(textoAlcance({ alcance: 'sensores', objetivos: ['sa'] }, { sa: 'Sede' })).toBe(
			'sensor "Sede"'
		);
		expect(textoAlcance({ alcance: 'sitios', objetivos: ['a', 'b'] })).toBe('2 sites');
	});

	it('el resumen dice lo callado, los eventos y lo que sigue sin volver', () => {
		const t = textoResumen(
			{ alcance: 'sensores', objetivos: ['sa'] },
			{
				eventos: 3,
				porSeveridad: { critica: 1, media: 2 },
				porTrampa: [],
				callados: [
					{ clave: 'sensor:sa', codigo: 'salud.sensor-sin-latido', nombre: 'Sede', desde: '' }
				],
				sinVolver: [{ id: 'sa', nombre: 'Sede' }]
			},
			{ sa: 'Sede' }
		);
		expect(t).toContain('3 events during the window (1 high or critical, which alerted as usual)');
		expect(t).toContain('1 health alert was held back');
		expect(t).toContain('still not responding: "Sede"');
	});
});
