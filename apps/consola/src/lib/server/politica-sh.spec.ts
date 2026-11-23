/*
 * El suelo de la política de cambios en los instaladores (politica.sh): el mismo bloque en el
 * nodo y en el sensor remoto, y acepta lo mismo que la consola (y el actualizador) sabe leer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLITICA_SH } from './politica-sh';
import { leerVentanas, politicaDelEntorno } from '$lib/politica-actualizacion';

const correr = (entorno: Record<string, string>, env = 'OTRA=1\n') => {
	const dir = mkdtempSync(join(tmpdir(), 'sd-politica-'));
	writeFileSync(join(dir, '.env'), env);
	const r = spawnSync(
		'/bin/bash',
		[
			'-c',
			`set -Eeuo pipefail\n${POLITICA_SH}\nsd_politica_comprobar\nsd_politica_env "${dir}/.env"`
		],
		{ env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...entorno }, encoding: 'utf8' }
	);
	return { r, env: readFileSync(join(dir, '.env'), 'utf8') };
};

describe('política de cambios en los instaladores', () => {
	it('el nodo y el sensor remoto llevan el mismo bloque', () => {
		/* El sensor remoto es de Cloud: el árbol Community no trae su instalador. */
		const remoto = new URL('../../../../../despliegue/sensor-remoto/', import.meta.url);
		const ficheros = ['despliegue/nodo/instalar.sh'];
		if (existsSync(remoto)) ficheros.push('despliegue/sensor-remoto/instalar.sh');
		for (const f of ficheros)
			expect(
				readFileSync(new URL(`../../../../../${f}`, import.meta.url), 'utf8').includes(POLITICA_SH)
			).toBe(true);
	});

	it('deja en el .env lo que se da, y lo lee igual la consola', () => {
		const { r, env } = correr({
			ACTUALIZACION_POLITICA: 'manual',
			ACTUALIZACION_RETARDO_HORAS: '72',
			ACTUALIZACION_VENTANA: '1-5 02:00-05:00 Europe/Madrid; 6,7 00:00-00:00'
		});
		expect(r.status, r.stderr).toBe(0);
		expect(env).toContain('OTRA=1');
		const leido = Object.fromEntries(
			env
				.trim()
				.split('\n')
				.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')])
		);
		const p = politicaDelEntorno((k) => leido[k]);
		expect(p.ventanaIlegible).toBe(false);
		expect(p).toMatchObject({ modo: 'manual', retardoHoras: 72 });
		expect(p.ventanas).toHaveLength(2);
	});

	it('sin nada, no toca el .env (ni al reinstalar)', () => {
		const antes = 'ACTUALIZACION_POLITICA=manual\n';
		const { r, env } = correr({}, antes);
		expect(r.status).toBe(0);
		expect(env).toBe(antes);
	});

	it.each([
		[{ ACTUALIZACION_POLITICA: 'manul' }, 'politica.modo'],
		[{ ACTUALIZACION_RETARDO_HORAS: '721' }, 'politica.retardo'],
		[{ ACTUALIZACION_RETARDO_HORAS: '072' }, 'politica.retardo'],
		[{ ACTUALIZACION_RETARDO_HORAS: '-1' }, 'politica.retardo'],
		[{ ACTUALIZACION_VENTANA: 'laborables de 2 a 5' }, 'politica.ventana'],
		[{ ACTUALIZACION_VENTANA: '5-1 02:00-05:00' }, 'politica.ventana'],
		[{ ACTUALIZACION_VENTANA: '1 24:00-05:00' }, 'politica.ventana'],
		[{ ACTUALIZACION_VENTANA: '1 02:00-05:00 ../../etc/passwd' }, 'politica.ventana'],
		[{ ACTUALIZACION_VENTANA: '1 02:00-05:00 Marte/Olimpo' }, 'politica.ventana']
	])('rechaza %o antes de escribir nada', (entorno, codigo) => {
		const { r, env } = correr(entorno as Record<string, string>);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(codigo);
		expect(env).toBe('OTRA=1\n');
	});

	it('lo que acepta la ventana del instalador lo lee la consola, y lo que rechaza también lo rechaza', () => {
		const casos = [
			'1-5 02:00-05:00',
			'1,3,5 22:00-02:00 Europe/Madrid',
			'7 00:00-00:00 America/New_York; 6 10:00-12:00',
			'1-5',
			'8 02:00-03:00',
			'1 2:00-03:00'
		];
		for (const v of casos) {
			const instalador = correr({ ACTUALIZACION_VENTANA: v }).r.status === 0;
			expect(instalador, v).toBe(leerVentanas(v) !== null);
		}
	});
});
