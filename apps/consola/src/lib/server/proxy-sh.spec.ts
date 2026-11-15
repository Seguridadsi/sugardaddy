/*
 * El bloque del proxy de salida (proxy.sh): que instalar.sh del nodo lleva el
 * mismo texto, y lo que deja en el .env ejecutado con bash de verdad.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROXY_SH } from './proxy-sh';

const carpetas: string[] = [];
afterEach(() => carpetas.splice(0).forEach((c) => rmSync(c, { recursive: true, force: true })));

const nueva = () => {
	const d = mkdtempSync(join(tmpdir(), 'sd-proxy-'));
	carpetas.push(d);
	return d;
};

/* Prepara el proxy en la carpeta con este entorno y escribe su .env; devuelve el .env y la salida. */
function preparar(dir: string, entorno: Record<string, string>, extra: string[] = []) {
	if (!existsSync(join(dir, '.env'))) writeFileSync(join(dir, '.env'), 'NODO_ID=n\n');
	const script = `set -Eeuo pipefail\n${PROXY_SH}\nsd_proxy_preparar "${dir}" ${extra.map((e) => `'${e}'`).join(' ')}\nsd_proxy_env "${dir}/.env"\necho "fuera=\${https_proxy:-}|\${no_proxy:-}"\n`;
	const r = spawnSync('/bin/bash', ['-c', script], {
		env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...entorno },
		encoding: 'utf8'
	});
	const env = existsSync(join(dir, '.env')) ? readFileSync(join(dir, '.env'), 'utf8') : '';
	const valor = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
	return { r, valor };
}

describe('proxy de salida en los instaladores', () => {
	it('instalar.sh del nodo lleva el mismo bloque que el sensor remoto', () => {
		const instalar = readFileSync(
			new URL('../../../../../despliegue/nodo/instalar.sh', import.meta.url),
			'utf8'
		);
		expect(instalar.includes(PROXY_SH)).toBe(true);
	});

	it('con proxy: lo exporta, añade las excepciones propias y lo deja en el .env', () => {
		const d = nueva();
		const { r, valor } = preparar(
			d,
			{
				SUGARDADDY_PROXY: 'http://banco%40:cla%24ve@proxy.banco.local:3128/',
				NO_PROXY: 'intranet.local; 10.0.0.0/8'
			},
			['consola.banco.local', '10.70.0.0/24']
		);
		expect(r.status, r.stderr).toBe(0);
		expect(valor('PROXY_SALIDA')).toBe('http://banco%40:cla%24ve@proxy.banco.local:3128');
		expect(valor('PROXY_EXCEPCIONES_CLIENTE')).toBe('intranet.local,10.0.0.0/8');
		expect(valor('PROXY_EXCEPCIONES')).toBe(
			'localhost,127.0.0.1,::1,consola,postgres,https,sensor,actualizador,consola.banco.local,10.70.0.0/24,intranet.local,10.0.0.0/8'
		);
		expect(valor('PROXY_CA')).toBe('');
		expect(r.stdout).toContain('fuera=http://banco%40:cla%24ve@proxy.banco.local:3128|localhost');
		/* La contraseña no sale por pantalla. */
		const aviso = r.stdout.split('\n').find((l) => l.startsWith('==> Outbound proxy'));
		expect(aviso).toBe('==> Outbound proxy: http://***@proxy.banco.local:3128');
		expect(valor('NODO_ID')).toBe('n');
	});

	it('sin nada en el entorno, conserva lo de la instalación anterior; «none» lo quita', () => {
		const d = nueva();
		preparar(d, { SUGARDADDY_PROXY: 'http://proxy:3128', SUGARDADDY_NO_PROXY: 'intra.local' });
		let { valor } = preparar(d, {});
		expect(valor('PROXY_SALIDA')).toBe('http://proxy:3128');
		expect(valor('PROXY_EXCEPCIONES_CLIENTE')).toBe('intra.local');
		({ valor } = preparar(d, { SUGARDADDY_PROXY: 'none' }));
		expect(valor('PROXY_SALIDA')).toBe('');
		expect(valor('PROXY_EXCEPCIONES')).toBe('');
	});

	it('deja un proxy.sh para cambiarlo después sin la línea de instalación', () => {
		const d = nueva();
		writeFileSync(join(d, '.env'), 'CONSOLA_URL=https://consola.banco.local\n');
		const r = spawnSync(
			'/bin/bash',
			['-c', `set -Eeuo pipefail\n${PROXY_SH}\nsd_proxy_guion "${d}"`],
			{
				env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
				encoding: 'utf8'
			}
		);
		expect(r.status, r.stderr).toBe(0);
		const guion = readFileSync(join(d, 'proxy.sh'), 'utf8');
		expect(spawnSync('/bin/bash', ['-n', join(d, 'proxy.sh')]).status).toBe(0);
		for (const f of ['sd_proxy_preparar', 'sd_proxy_docker', 'sd_proxy_env'])
			expect(guion).toContain(`${f} ()`);
		/* Sin nada que cambiar, enseña cómo se usa y no toca nada. */
		const uso = spawnSync('/bin/bash', [join(d, 'proxy.sh')], {
			encoding: 'utf8',
			env: { PATH: '/usr/bin:/bin' }
		});
		expect(uso.status).not.toBe(0);
	});

	it('rechaza un proxy mal escrito sin tocar nada', () => {
		const d = nueva();
		for (const p of [
			'proxy:3128',
			'http://us"er@proxy:3128',
			'http://u:p$x@proxy:3128',
			'socks5://proxy:1080'
		]) {
			const { r, valor } = preparar(d, { SUGARDADDY_PROXY: p });
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain('proxy.forma');
			expect(valor('PROXY_SALIDA')).toBeUndefined();
		}
	});

	it('la CA corporativa: solo certificados, y un fichero que no lo es se rechaza', () => {
		const d = nueva();
		const pem = join(d, 'ca.pem');
		const gen = spawnSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-keyout',
				join(d, 'k.pem'),
				'-out',
				pem,
				'-days',
				'1',
				'-subj',
				'/CN=Proxy del banco'
			],
			{ encoding: 'utf8' }
		);
		expect(gen.status, gen.stderr).toBe(0);
		writeFileSync(pem, `basura antes\n${readFileSync(pem, 'utf8')}`);
		const { r, valor } = preparar(d, { SUGARDADDY_PROXY_CA: pem });
		expect(r.status, r.stderr).toBe(0);
		expect(valor('PROXY_CA')).toBe('1');
		const guardada = readFileSync(join(d, 'proxy', 'ca.crt'), 'utf8');
		expect(guardada.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);
		expect(guardada).not.toContain('basura');
		const mala = preparar(d, { SUGARDADDY_PROXY_CA: join(d, 'k.pem') });
		expect(mala.r.status).not.toBe(0);
		expect(mala.r.stderr).toContain('proxy.ca');
		/* La anterior sigue. */
		expect(preparar(d, {}).valor('PROXY_CA')).toBe('1');
		expect(preparar(d, { SUGARDADDY_PROXY_CA: 'none' }).valor('PROXY_CA')).toBe('');
	});
});
