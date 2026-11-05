/*
 * La lógica pura de los destinos: qué campos lleva cada tipo, qué sistemas y
 * versiones se ofrecen, qué campos manda el sensor (no se editan) y la etiqueta
 * de plataforma de las listas. Sin BD ni red: todo con Hecho en memoria.
 */
import { describe, expect, it } from 'vitest';
import { camposDe, camposDelSensor, plataformaDe, sistemasDe, versionesWindows } from './destinos';

type Fuente = 'sensor' | 'consola' | 'formulario';
const hecho = (valor: string, fuente?: Fuente) => ({ valor, ...(fuente ? { fuente } : {}) });

describe('camposDe', () => {
	it('da los campos del tipo y [] para lo que no tiene o no existe', () => {
		expect(camposDe('maquina')).toEqual([
			'direccion',
			'so',
			'edicion',
			'version',
			'powershell',
			'posix'
		]);
		expect(camposDe('otro')).toEqual(['so', 'nota']);
		expect(camposDe('paas-web')).toEqual([]);
		expect(camposDe('no-existe')).toEqual([]);
	});
});

describe('sistemasDe', () => {
	it('un servidor de ficheros ofrece NAS (no macOS); los demás, macOS', () => {
		expect(sistemasDe('fileserver').map((x) => x.valor)).toEqual(['windows', 'linux', 'nas']);
		expect(sistemasDe('fileserver').find((x) => x.valor === 'linux')?.texto).toBe(
			'Linux con Samba'
		);
		expect(sistemasDe('maquina').map((x) => x.valor)).toEqual(['windows', 'linux', 'macos']);
	});
});

describe('versionesWindows', () => {
	it('filtra por edición; un servidor de ficheros fuerza «servidor»; sin edición, todas', () => {
		expect(versionesWindows('maquina')).toHaveLength(6);
		expect(versionesWindows('maquina', 'puesto').map((x) => x.valor)).toEqual([
			'10.0.19045',
			'10.0.22000'
		]);
		expect(versionesWindows('maquina', 'servidor').every((x) => x.edicion === 'servidor')).toBe(
			true
		);
		expect(versionesWindows('maquina', 'servidor')).toHaveLength(4);
		/* fileserver ignora la edición pasada y solo da ediciones de servidor. */
		expect(versionesWindows('fileserver', 'puesto').every((x) => x.edicion === 'servidor')).toBe(
			true
		);
		expect(versionesWindows('fileserver', 'puesto')).toHaveLength(4);
	});
});

describe('camposDelSensor', () => {
	it('solo bloquea el campo cuyo hecho da el sensor', () => {
		expect(camposDelSensor({ 'plataforma.so': hecho('x', 'sensor') })).toContain('so');
		expect(camposDelSensor({ 'plataforma.so': hecho('x', 'formulario') })).not.toContain('so');
		expect(camposDelSensor({ 'plataforma.so': hecho('x', 'consola') })).not.toContain('so');
		expect(camposDelSensor({})).toEqual([]);
		const r = camposDelSensor({
			'plataforma.so': hecho('x', 'sensor'),
			'shell.powershell': hecho('x', 'formulario')
		});
		expect(r).toContain('so');
		expect(r).not.toContain('powershell');
	});
});

describe('plataformaDe', () => {
	it('manda lo que dice el sensor de su máquina', () => {
		expect(
			plataformaDe({
				'plataforma.so': hecho('linux', 'sensor'),
				'motor.sistema': hecho('Ubuntu 24.04.1 LTS', 'sensor')
			})
		).toBe('Ubuntu 24.04.1 LTS');
	});
	it('con el sistema del sensor vacío, cae al nombre del SO', () => {
		expect(
			plataformaDe({
				'plataforma.so': hecho('linux', 'sensor'),
				'motor.sistema': hecho('', 'sensor')
			})
		).toBe('Linux');
	});
	it('sin datos es null; un SO suelto da su nombre', () => {
		expect(plataformaDe({})).toBeNull();
		expect(plataformaDe({ 'plataforma.so': hecho('linux', 'sensor') })).toBe('Linux');
	});
	it('una versión de Windows conocida da su nombre comercial', () => {
		expect(
			plataformaDe({
				'plataforma.so': hecho('windows', 'formulario'),
				'plataforma.version': hecho('10.0.17763', 'formulario')
			})
		).toBe('Windows Server 2019');
		expect(
			plataformaDe({
				'plataforma.so': hecho('windows', 'formulario'),
				'plataforma.version': hecho('10.0.22000', 'formulario')
			})
		).toBe('Windows 11');
	});
	it('una versión de Windows desconocida cae al build crudo', () => {
		expect(
			plataformaDe({
				'plataforma.so': hecho('windows', 'formulario'),
				'plataforma.version': hecho('10.0.99999', 'formulario')
			})
		).toBe('Windows 10.0.99999');
	});
	it('un SO sin versión da su nombre; uno desconocido, su valor crudo', () => {
		expect(plataformaDe({ 'plataforma.so': hecho('macos', 'formulario') })).toBe('macOS');
		expect(plataformaDe({ 'plataforma.so': hecho('freebsd', 'formulario') })).toBe('freebsd');
	});
	it('Linux con versión del formulario', () => {
		expect(
			plataformaDe({
				'plataforma.so': hecho('linux', 'formulario'),
				'plataforma.version': hecho('24.04', 'formulario')
			})
		).toBe('Linux 24.04');
	});
});
