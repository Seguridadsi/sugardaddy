/*
 * La tabla de comunidades autónomas: la escribe scripts/geo-espana.mjs (al
 * construir la imagen) y la lee geo.ts. Aquí se escribe desde un CSV pequeño
 * con el formato de DB-IP City Lite y se busca en ella.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { comunidadDe, leerEspana } from './geo';

const CSV = [
	'1.178.22.0,1.178.22.255,EU,ES,Aragon,Zaragoza,41.6,-0.8',
	'1.178.224.0,1.178.228.255,EU,ES,Madrid,"Pozuelo de Alarcón",40.4,-3.8',
	/* Contiguo y de la misma comunidad que el anterior: se junta. */
	'1.178.229.0,1.178.229.255,EU,ES,Madrid,Madrid,40.4,-3.7',
	'1.178.230.0,1.178.230.255,EU,ES,"Castille and León",Valladolid,41.6,-4.7',
	'200.1.1.0,200.1.1.255,SA,AR,"Buenos Aires",X,0,0',
	'2a02:9000::,2a02:9000:ffff:ffff:ffff:ffff:ffff:ffff,EU,ES,"Canary Islands",Telde,28,-15',
	'5.5.5.0,5.5.5.255,EU,ES,"Región inventada",X,0,0'
].join('\n');

function tabla() {
	const f = join(mkdtempSync(join(tmpdir(), 'sd-es-')), 'espana.bin');
	const salida = execFileSync('node', ['scripts/geo-espana.mjs', f], {
		input: CSV,
		encoding: 'utf8'
	});
	return { e: leerEspana(readFileSync(f))!, salida };
}

describe('mapa de España: comunidad de cada IP', () => {
	it('junta los rangos seguidos de la misma comunidad y avisa de lo que no conoce', () => {
		const { e, salida } = tabla();
		expect(e.n4).toBe(3);
		expect(e.n6).toBe(1);
		expect(salida).toContain('Región inventada');
	});

	it('encuentra la comunidad de IPv4, IPv6 e IPv4 escrita como IPv6', () => {
		const { e } = tabla();
		expect(comunidadDe(e, '1.178.22.7')).toBe('AR');
		expect(comunidadDe(e, '1.178.224.0')).toBe('MD');
		expect(comunidadDe(e, '1.178.229.255')).toBe('MD');
		expect(comunidadDe(e, '1.178.230.1')).toBe('CL');
		expect(comunidadDe(e, '::ffff:1.178.22.9')).toBe('AR');
		expect(comunidadDe(e, '2a02:9000:1::5')).toBe('CN');
	});

	it('fuera de los rangos, o lo que no es una IP, no tiene comunidad', () => {
		const { e } = tabla();
		for (const ip of [
			'1.178.21.255',
			'1.178.231.0',
			'200.1.1.1',
			'5.5.5.5',
			'2a02:9001::1',
			'hola',
			''
		])
			expect(comunidadDe(e, ip)).toBeNull();
	});

	it('un fichero que no es la tabla no se lee', () => {
		expect(leerEspana(Buffer.from('otra cosa'))).toBeNull();
	});
});
