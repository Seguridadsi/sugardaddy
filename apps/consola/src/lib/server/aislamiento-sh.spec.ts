/*
 * El bloque del aislamiento de las trampas (aislamiento.sh): que el instalar.sh del nodo y
 * el del sensor remoto llevan el mismo texto, y que en una máquina sin AppArmor ni systemd
 * no toca nada ni para la instalación.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AISLAMIENTO_SH } from './aislamiento-sh';

const NODO = new URL('../../../../../despliegue/nodo/instalar.sh', import.meta.url);
const SENSOR = new URL('../../../../../despliegue/sensor-remoto/instalar.sh', import.meta.url);

describe('aislamiento de las trampas en los instaladores', () => {
	/* El instalar.sh del nodo no entra en el árbol de Community con el mismo texto. */
	it.skipIf(!existsSync(NODO))('instalar.sh del nodo lleva el bloque y lo llama', () => {
		const t = readFileSync(NODO, 'utf8');
		expect(t.includes(AISLAMIENTO_SH)).toBe(true);
		expect(t).toContain('sd_aislar_trampas "$DIR/.env" "$DIR/datos/sensor" "$SENSOR_IMG"');
	});

	/* Solo en Cloud: el árbol de Community no lleva despliegue/sensor-remoto. */
	it.skipIf(!existsSync(SENSOR))('el del sensor remoto, también, con su carpeta de datos', () => {
		const t = readFileSync(SENSOR, 'utf8');
		expect(t.includes(AISLAMIENTO_SH)).toBe(true);
		expect(t).toContain('sd_aislar_trampas "$DIR/.env" "$DIR/datos" ');
		/* Después de comprobar la propagación y antes de arrancar el sensor. */
		expect(t.indexOf('sd_aislar_trampas "$DIR/.env"')).toBeGreaterThan(
			t.indexOf('PASO="check mount propagation"')
		);
		expect(t.indexOf('sd_aislar_trampas "$DIR/.env"')).toBeLessThan(
			t.indexOf('PASO="start the sensor"')
		);
	});

	it('es bash válido, y sin AppArmor ni systemd no toca el .env ni para', () => {
		const d = mkdtempSync(join(tmpdir(), 'sd-aislar-'));
		try {
			writeFileSync(join(d, '.env'), 'A=1\n');
			writeFileSync(join(d, 'docker'), '#!/bin/sh\necho docker >> "$0.llamado"; exit 1\n', {
				mode: 0o755
			});
			const guion = `set -Eeuo pipefail\n${AISLAMIENTO_SH}\nsd_aislar_trampas "${d}/.env" /opt/x/datos imagen@sha256:1\necho fin`;
			const r = spawnSync('/bin/bash', ['-c', guion], {
				/* Sin apparmor_parser ni systemctl en el PATH: no aplica nada. */
				env: { PATH: `${d}:/bin` },
				encoding: 'utf8'
			});
			expect(r.status).toBe(0);
			expect(r.stdout.trim()).toBe('fin');
			expect(readFileSync(join(d, '.env'), 'utf8')).toBe('A=1\n');
			expect(existsSync(join(d, 'docker.llamado'))).toBe(false);
			/* Y la orden que deja el valor en el .env, sin repetir la clave. */
			const env = spawnSync(
				'/bin/bash',
				[
					'-c',
					`${AISLAMIENTO_SH}\nsd_aislar_env "${d}/.env" TRAMPAS_APPARMOR x\nsd_aislar_env "${d}/.env" TRAMPAS_APPARMOR sugardaddy-trampa`
				],
				{ env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }
			);
			expect(env.status).toBe(0);
			expect(readFileSync(join(d, '.env'), 'utf8')).toBe(
				'A=1\nTRAMPAS_APPARMOR=sugardaddy-trampa\n'
			);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
