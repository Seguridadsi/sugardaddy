import { describe, expect, it } from 'vitest';
import { avisosSensor, resumenMotor } from './capacidades';

const motor = {
	tipo: 'docker',
	modo: 'rootful',
	version: '27.5.1',
	api: '1.47',
	arquitectura: 'arm64'
};

describe('lo que la consola enseña del motor de cada sensor', () => {
	it('resume el motor en una línea', () => {
		expect(resumenMotor(motor)).toBe('Docker 27.5.1 · con root · arm64 · API 1.47');
		expect(resumenMotor({ tipo: 'podman', version: '5.2.1', modo: 'rootless' })).toBe(
			'Podman 5.2.1 · sin root'
		);
	});

	it('sin motor, o con su fallo, no hay resumen', () => {
		expect(resumenMotor(null)).toBeNull();
		expect(resumenMotor({ codigo: 'motor.permiso', error: 'x' })).toBeNull();
	});

	it('un sensor 0.12 o 0.13.0 no cuenta nada y no tiene avisos', () => {
		expect(avisosSensor(null)).toEqual([]);
		expect(avisosSensor({ motor, hechos: {} })).toEqual([]);
	});

	it('un fallo general del motor es un error con su código y el texto del sensor', () => {
		const [a] = avisosSensor({
			motor: {
				codigo: 'motor.permiso',
				error:
					'el sensor no tiene permiso para usar el motor de contenedores por /var/run/docker.sock: revisa los permisos del socket'
			},
			hechos: {}
		});
		expect(a).toMatchObject({ codigo: 'motor.permiso', gravedad: 'error' });
		expect(a.titulo).toMatch(/permiso/);
		expect(a.texto).toMatch(/^El sensor no tiene permiso .* socket\. Hasta que se arregle/);
	});

	it('un código de motor que esta consola no conoce también se enseña', () => {
		const [a] = avisosSensor({ motor: { codigo: 'motor.nuevo', error: 'algo raro.' }, hechos: {} });
		expect(a).toMatchObject({ codigo: 'motor.nuevo', gravedad: 'error' });
		expect(a.texto).toMatch(/^Algo raro\. Hasta/);
	});

	it.each([
		['origen.pasarela', /iptables/],
		['origen.desktop', /Docker Desktop/],
		['origen.wsl', /WSL2/],
		['origen.rootless', /sin root/],
		['origen.otro-futuro', /motor de contenedores/]
	])('avisa de que las trampas no ven la IP real (%s)', (motivo, explica) => {
		const [a] = avisosSensor({
			motor,
			hechos: { 'red.ipOrigenReal': { valor: false, motivo } }
		});
		expect(a).toMatchObject({ codigo: motivo, gravedad: 'aviso' });
		expect(a.texto).toMatch(explica);
		expect(a.texto).toMatch(/no bloquees/);
	});

	it('con la IP real no hay aviso', () => {
		expect(
			avisosSensor({
				motor,
				hechos: { 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' } }
			})
		).toEqual([]);
	});

	it('un motor que ya no habla ninguna versión comprobada de la API se avisa', () => {
		const [a] = avisosSensor({ motor: { ...motor, api: '1.60', sinGarantia: true }, hechos: {} });
		expect(a).toMatchObject({ codigo: 'motor.sin-garantia', gravedad: 'aviso' });
		expect(a.texto).toMatch(/1\.60/);
	});

	it('un motor que bloquea clone3 se avisa, sin tumbar el sensor', () => {
		const [a, ...resto] = avisosSensor({
			motor: { ...motor, version: '20.10.9' },
			hechos: { 'motor.clone3': { valor: false, motivo: 'clone3.bloqueado' } }
		});
		expect(resto).toEqual([]);
		expect(a).toMatchObject({ codigo: 'clone3.bloqueado', gravedad: 'aviso' });
		expect(a.texto).toMatch(/clone3/);
		expect(a.texto).toMatch(/Actualiza Docker/);
	});

	it('con clone3 disponible no hay aviso', () => {
		expect(
			avisosSensor({
				motor,
				hechos: { 'motor.clone3': { valor: true, motivo: 'clone3.disponible' } }
			})
		).toEqual([]);
	});

	it('el error del motor va antes que los avisos', () => {
		const avisos = avisosSensor({
			motor: { codigo: 'motor.inalcanzable', error: 'no responde' },
			hechos: { 'red.ipOrigenReal': { valor: false, motivo: 'origen.pasarela' } }
		});
		expect(avisos.map((a) => a.codigo)).toEqual(['motor.inalcanzable', 'origen.pasarela']);
	});
});
