/*
 * La detección de la red de los instaladores, ejecutada con bash y un ip
 * falso que contesta como el de una máquina de verdad.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectarRed } from './red-sh';

const carpetas: string[] = [];
afterEach(() => carpetas.splice(0).forEach((c) => rmSync(c, { recursive: true, force: true })));

/* Ejecuta la detección con estas órdenes en el PATH (nombre → script) y devuelve lo que deja. */
function detectar(ordenes: Record<string, string>) {
	const bin = mkdtempSync(join(tmpdir(), 'sd-red-'));
	carpetas.push(bin);
	for (const [n, cuerpo] of Object.entries(ordenes)) {
		writeFileSync(join(bin, n), `#!/bin/sh\n${cuerpo}\n`);
		chmodSync(join(bin, n), 0o755);
	}
	const sistema = ['awk', 'grep'].map((o) => `ln -s "$(command -v ${o})" "${bin}/${o}"`).join('\n');
	spawnSync('/bin/sh', ['-c', sistema]);
	const script = `set -Eeuo pipefail\n${detectarRed}\necho "$RED_DETECTADA|$VLAN_DETECTADA"\n`;
	const r = spawnSync('/bin/bash', ['-c', script], { env: { PATH: bin }, encoding: 'utf8' });
	expect(r.status, r.stderr).toBe(0);
	return r.stdout.trim();
}

/* Un ip que contesta como el de una máquina que sale por «dev», en «red», con «extra» en su enlace. */
const ip = (dev: string, red: string, extra = '') => ({
	ip: `case "$*" in
"-4 route show default") echo "default via 10.70.0.1 dev ${dev} proto dhcp src 10.70.0.5 metric 100" ;;
"-4 route show dev ${dev} proto kernel scope link") ${red ? `echo "${red} proto kernel scope link src 10.70.0.5"` : 'true'} ;;
"-d -o link show dev ${dev}") echo "3: ${dev}@eth0: <BROADCAST,MULTICAST,UP> mtu 1500 state UP \\\\    link/ether 52:54:00:12:34:56 brd ff:ff:ff:ff:ff:ff promiscuity 0 ${extra}" ;;
esac`
});

describe('detección de la red en los instaladores', () => {
	it('la red de la interfaz por la que sale', () => {
		expect(detectar(ip('eth0', '10.70.0.0/24'))).toBe('10.70.0.0/24|');
	});

	it('y su VLAN si la interfaz es una 802.1Q', () => {
		expect(
			detectar(ip('eth0.70', '10.70.0.0/24', 'vlan protocol 802.1Q id 70 <REORDER_HDR>'))
		).toBe('10.70.0.0/24|70');
	});

	it('sin ruta propia de la interfaz, o sin ip, vacías y sin fallar', () => {
		expect(detectar(ip('ens18', ''))).toBe('|');
		expect(detectar({})).toBe('|');
	});

	it('el instalador del nodo lleva el mismo texto', () => {
		const instalar = readFileSync(
			new URL('../../../../../despliegue/nodo/instalar.sh', import.meta.url),
			'utf8'
		);
		expect(instalar).toContain(detectarRed);
	});
});
