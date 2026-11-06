/*
 * La comprobación de arquitectura del instalador del sensor remoto, ejecutada
 * con bash y un docker (o un dpkg) falso que dice qué motor hay.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { comprobarArquitectura } from './arquitectura-sh';

const carpetas: string[] = [];
afterEach(() => carpetas.splice(0).forEach((c) => rmSync(c, { recursive: true, force: true })));

const DESPUES = 'this line has already been used: generate a new one.';

/* Ejecuta la comprobación con solo estas órdenes en el PATH (nombre → script). */
function ejecutar(ordenes: Record<string, string>) {
	const bin = mkdtempSync(join(tmpdir(), 'sd-arq-'));
	carpetas.push(bin);
	for (const [n, cuerpo] of Object.entries(ordenes)) {
		writeFileSync(join(bin, n), `#!/bin/sh\n${cuerpo}\n`);
		chmodSync(join(bin, n), 0o755);
	}
	const script = `set -Eeuo pipefail\n${comprobarArquitectura('this sensor', DESPUES)}\necho SIGUE\n`;
	const r = spawnSync('/bin/bash', ['-c', script], {
		env: { PATH: bin, LANG: 'C.UTF-8' },
		encoding: 'utf8'
	});
	return { codigo: r.status, salida: r.stdout, error: r.stderr };
}

const docker = (plataforma: string) => ({
	docker: `[ "$1" = version ] && echo '${plataforma}' && exit 0; exit 1`
});

describe('comprobación de arquitectura del sensor remoto', () => {
	it('con un motor linux/amd64 sigue', () => {
		expect(ejecutar(docker('linux/amd64'))).toMatchObject({ codigo: 0, salida: 'SIGUE\n' });
	});

	it('con un motor arm64 sale antes de seguir, con su código y un texto claro', () => {
		const r = ejecutar(docker('linux/arm64'));
		expect(r.codigo).toBe(1);
		expect(r.salida).toBe('');
		expect(r.error).toContain('this sensor needs a Linux amd64 (x86_64) Docker engine');
		expect(r.error).toContain('linux/arm64');
		expect(r.error).toContain('(code instalar.arquitectura)');
	});

	it('dice que la línea ya se ha gastado y qué hacer para la otra máquina', () => {
		const r = ejecutar(docker('linux/arm64'));
		expect(r.error).toContain(`Nothing was changed on this one, but ${DESPUES} (code`);
	});

	it('un motor de Windows tampoco vale', () => {
		expect(ejecutar(docker('windows/amd64')).codigo).toBe(1);
	});

	it('sin Docker, mira la arquitectura de los paquetes que se instalarían', () => {
		expect(ejecutar({ dpkg: 'echo arm64' })).toMatchObject({ codigo: 1, salida: '' });
		expect(ejecutar({ dpkg: 'echo amd64' })).toMatchObject({ codigo: 0, salida: 'SIGUE\n' });
	});

	it('si el motor no contesta, no decide aquí', () => {
		expect(
			ejecutar({ docker: 'echo "Cannot connect to the Docker daemon" >&2; exit 1' })
		).toMatchObject({ codigo: 0, salida: 'SIGUE\n' });
		expect(ejecutar({})).toMatchObject({ codigo: 0, salida: 'SIGUE\n' });
	});
});

it('el instalador del sensor remoto la hace antes de instalar Docker o escribir nada', () => {
	const s = readFileSync(new URL('./sensores-remotos.ts', import.meta.url), 'utf8');
	const arq = s.indexOf("${comprobarArquitectura('this sensor', LINEA_GASTADA)}");
	expect(arq).toBeGreaterThan(s.indexOf('id -u'));
	expect(arq).toBeLessThan(s.indexOf('PASO="install Docker"'));
	expect(arq).toBeLessThan(s.indexOf('mkdir -p "$DIR'));
});

it('y le dice que genere otra línea en Sensores: la que ha usado ya no vale', () => {
	const s = readFileSync(new URL('./sensores-remotos.ts', import.meta.url), 'utf8');
	const texto = s.match(/const LINEA_GASTADA =\s*'([^']+)'/)?.[1];
	expect(texto).toContain('this line has already been used');
	expect(texto).toContain('generate a new one in Sensors in the console');
	expect(texto).not.toMatch(/["$`]/);
});
