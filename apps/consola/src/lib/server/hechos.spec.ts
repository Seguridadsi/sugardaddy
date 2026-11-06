import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { camposDelSensor } from '$lib/destinos';
import { hechosDe, ipDeLaMaquina, type SensorDeHechos } from './hechos';

const sensor = (direcciones: unknown, red: string | null = null, extra = {}): SensorDeHechos => ({
	id: 'nave',
	versionAgente: '0.22.5',
	registroPrivado: false,
	red,
	capacidades: {
		cuando: '2026-11-06T10:00:00.000Z',
		hechos: { 'red.direcciones': { valor: direcciones }, ...extra }
	} as unknown as SensorDeHechos['capacidades']
});

describe('la IP de la máquina de un sensor', () => {
	it('la que cae en su red; si no se sabe, la primera privada; si no, la primera', () => {
		const ips = ['10.0.0.11', '192.168.5.6'];
		expect(ipDeLaMaquina(ips, '192.168.5.0/24')).toBe('192.168.5.6');
		expect(ipDeLaMaquina(ips, '10.0.0.0/24')).toBe('10.0.0.11');
		expect(ipDeLaMaquina(ips, null)).toBe('10.0.0.11');
		expect(ipDeLaMaquina(['52.1.2.3', '10.0.0.11'], null)).toBe('10.0.0.11');
		expect(ipDeLaMaquina(['52.1.2.3'], null)).toBe('52.1.2.3');
		/* Una red que no casa con ninguna (o mal escrita): como si no se supiera. */
		expect(ipDeLaMaquina(ips, '172.16.0.0/12')).toBe('10.0.0.11');
		expect(ipDeLaMaquina(ips, 'no-es-red')).toBe('10.0.0.11');
	});

	it('sin nada que contar (un sensor anterior a la 0.17.1), ninguna', () => {
		expect(ipDeLaMaquina(undefined, '10.0.0.0/24')).toBeNull();
		expect(ipDeLaMaquina([], null)).toBeNull();
		expect(ipDeLaMaquina(['', 'fs01', 3], null)).toBeNull();
	});
});

describe('la dirección de un destino', () => {
	const direccion = (d: { descripcion: object }, x: SensorDeHechos | null) =>
		hechosDe(d, x)['destino.direccion'];

	it('con sensor y sin escribirla, la que cuenta el sensor de su máquina', () => {
		expect(
			direccion({ descripcion: {} }, sensor(['192.168.5.6', '10.0.0.11'], '10.0.0.0/24'))
		).toEqual({
			valor: '10.0.0.11',
			fuente: 'consola',
			cuando: '2026-11-06T10:00:00.000Z'
		});
	});

	it('lo que escribe el cliente manda, también sobre lo que cuenta el sensor', () => {
		expect(
			direccion({ descripcion: { direccion: 'fs01.empresa.local' } }, sensor(['10.0.0.11']))
		).toEqual({ valor: 'fs01.empresa.local', fuente: 'formulario' });
	});

	it('se puede corregir: el formulario no bloquea el campo', () => {
		expect(camposDelSensor(hechosDe({ descripcion: {} }, sensor(['10.0.0.11'])))).not.toContain(
			'direccion'
		);
	});

	it('sin sensor o sin IP que contar, no hay dirección: no se inventa', () => {
		expect(direccion({ descripcion: {} }, null)).toBeUndefined();
		expect(direccion({ descripcion: {} }, sensor([]))).toBeUndefined();
	});

	it('el sensor no la puede dictar por su cuenta: solo cuenta sus IP', () => {
		const x = sensor(['10.0.0.11'], null, { 'destino.direccion': { valor: 'atacante.example' } });
		expect(direccion({ descripcion: {} }, x)?.valor).toBe('10.0.0.11');
	});
});

/*
 * Lo sembrado tiene que llevar a donde atiende la trampa: con otra ruta, quien
 * use la configuración recibe un 404 y no hay evento, y la trampa no avisa.
 */
describe('configuracion-mcp apunta a la ruta del servidor MCP', () => {
	const modulos = join(process.cwd(), '../../modulos/trampas');
	const servidor = join(modulos, 'mcp/imagen/fuente/config.go');
	const sembrada = join(modulos, 'configuracion-mcp/trampa.yaml');

	it.skipIf(!existsSync(servidor) || !existsSync(sembrada))('la siembra y la prueba', () => {
		const ruta = /env\("SD_MCP_RUTA", "([^"]+)"\)/.exec(readFileSync(servidor, 'utf8'))?.[1];
		expect(ruta).toBeTruthy();
		const urls = readFileSync(sembrada, 'utf8')
			.split('\n')
			.filter((l) => l.includes('http://'));
		/* Colocar y probar, en Windows y en Linux. */
		expect(urls).toHaveLength(4);
		for (const l of urls) expect(l).toMatch(new RegExp(`(PUERTOMCP|puertoMcp \\+ ')${ruta}["']`));
	});
});
