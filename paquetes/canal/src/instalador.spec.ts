import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CABECERA_ETAPA1,
	clavesDeEtapa1,
	FICHEROS_INSTALADOR,
	firmaParaOpenssl,
	firmarRelease,
	generarClaves,
	huellaEtapa1,
	huellasDe,
	huellasSensorDe,
	MARCA_HUELLAS,
	MARCA_HUELLAS_SENSOR,
	motivoVersionNodos,
	piezasInstalador,
	piezasInstaladorSensor,
	releaseParaNodos,
	sellarEtapa1,
	tamanoParaNodos,
	verificarRelease,
	type Release
} from './index.ts';

const ETAPA1 = readFileSync(resolve(process.cwd(), '../../despliegue/nodo/etapa1.sh'), 'utf8');
const kino = generarClaves();
const D = '@sha256:' + 'a'.repeat(64);

function release(cambios: (r: Release) => void = () => {}): Release {
	const r: Release = {
		version: '9.9.1',
		publicada: new Date().toISOString(),
		notas: 'prueba',
		servicios: {
			consola: `ghcr.io/seguridadsi/sugardaddy-consola${D}`,
			sensor: `ghcr.io/seguridadsi/sugardaddy-sensor${D}`
		},
		actualizador: `ghcr.io/seguridadsi/sugardaddy-actualizador${D}`,
		nodo: {
			ficheros: { 'compose.yml': 'name: prueba\n', Caddyfile: '{\n}\n' },
			entorno: { nuevas: { NUEVA: 'un valor' }, generar: ['SECRETO'] }
		},
		instalador: {
			huellas: '',
			ficheros: Object.fromEntries(FICHEROS_INSTALADOR.map((n) => [n, `#!/bin/sh\n# ${n}\n`])),
			etapa1: { texto: ETAPA1, firmas: [] }
		}
	};
	r.instalador!.huellas = huellasDe(piezasInstalador(r)!);
	cambios(r);
	return r;
}
const comprobar = (r: Release) => verificarRelease(kino.publica, firmarRelease(kino.privada, r));

describe('el instalador de una versión', () => {
	it('las piezas son los guiones, la configuración firmada, las imágenes y el entorno', () => {
		const p = piezasInstalador(release())!;
		expect(Object.keys(p)).toEqual([
			'instalar.sh',
			'copia.sh',
			'restaurar.sh',
			'compose.yml',
			'Caddyfile',
			'imagenes.env',
			'entorno.txt'
		]);
		expect(p['imagenes.env']).toBe(
			`SUGARDADDY_VERSION=9.9.1\nCONSOLA_IMAGEN=ghcr.io/seguridadsi/sugardaddy-consola${D}\n` +
				`SENSOR_IMAGEN=ghcr.io/seguridadsi/sugardaddy-sensor${D}\n` +
				`ACTUALIZADOR_IMAGEN=ghcr.io/seguridadsi/sugardaddy-actualizador${D}\n`
		);
		expect(p['entorno.txt']).toBe('nueva NUEVA=un valor\ngenerar SECRETO\n');
	});

	it('una versión con su instalador se verifica, y sus huellas van una sola vez en lo firmado', () => {
		const f = firmarRelease(kino.privada, release());
		const v = verificarRelease(kino.publica, f);
		expect(v.ok).toBe(true);
		expect(f.release.split(MARCA_HUELLAS)).toHaveLength(2);
		/* Dentro va la primera etapa, que busca esa marca: escapada, no cuenta. */
		expect(ETAPA1).toContain(MARCA_HUELLAS);
	});

	it('sin instalador sigue valiendo (las de antes), y no trae piezas', () => {
		const r = release((x) => delete x.instalador);
		expect(comprobar(r).ok).toBe(true);
		expect(piezasInstalador(r)).toBeNull();
	});

	it.each([
		[
			'unas huellas que no son las de sus ficheros',
			(r: Release) => (r.instalador!.huellas = 'v1;instalar.sh=' + '0'.repeat(64))
		],
		[
			'un guion cambiado después de calcular las huellas',
			(r: Release) => (r.instalador!.ficheros['instalar.sh'] = '#!/bin/sh\nrm -rf /\n')
		],
		[
			'un compose cambiado después de calcular las huellas',
			(r: Release) => (r.nodo!.ficheros['compose.yml'] = 'name: otra\n')
		],
		['un guion de más', (r: Release) => (r.instalador!.ficheros['otro.sh'] = '#!/bin/sh\n')],
		['un guion de menos', (r: Release) => delete r.instalador!.ficheros['copia.sh']],
		[
			'una primera etapa que no lo es',
			(r: Release) => (r.instalador!.etapa1.texto = '#!/bin/sh\necho hola\n')
		],
		[
			'firmas de la primera etapa mal formadas',
			(r: Release) => (r.instalador!.etapa1.firmas = [{ clave: 'x', firma: 'y' }])
		],
		['sin la configuración del nodo', (r: Release) => delete r.nodo]
	])('no se verifica con %s', (_, cambio) => {
		expect(comprobar(release(cambio)).ok).toBe(false);
	});

	it('no se verifica si la marca de las huellas sale dos veces en lo firmado', () => {
		/* No puede pasar con un JSON de verdad; se fuerza para comprobar que se mira. */
		const r = release();
		const v = verificarRelease(
			kino.publica,
			firmarRelease(kino.privada, { ...r, [MARCA_HUELLAS.slice(1, -6)]: 'v1;x' } as Release)
		);
		expect(v.ok).toBe(false);
	});
});

describe('la primera etapa', () => {
	const ed = generarClaves().publica;
	const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const ec = p256.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

	it('la del repositorio empieza por su cabecera y tiene el bloque de claves', () => {
		expect(ETAPA1.startsWith(CABECERA_ETAPA1)).toBe(true);
		expect(clavesDeEtapa1(ETAPA1)).not.toBeNull();
	});

	/* El repositorio público no lleva el appliance: allí no hay copia que comparar. */
	const copia = resolve(
		process.cwd(),
		'../../despliegue/appliance/raiz/usr/local/lib/sugardaddy/etapa1.sh'
	);
	it.skipIf(!existsSync(copia))(
		'la que lleva la imagen del appliance es la misma, byte a byte',
		() => {
			/* Si falla: node --experimental-strip-types herramientas/etapa1.ts sellar */
			expect(readFileSync(copia, 'utf8')).toBe(ETAPA1);
		}
	);

	it('se sella solo con las claves de Cloud, y el resto del guion no cambia', () => {
		const lista = `cloud:${ec},community:${ed},licencias:${ed},delegaciones:${ed}`;
		const sellada = sellarEtapa1(ETAPA1, lista, ed);
		expect(clavesDeEtapa1(sellada)).toEqual({
			claves: `cloud:${ec},licencias:${ed},delegaciones:${ed}`,
			legado: ed
		});
		expect(sellarEtapa1(sellada, '', ed).replace(ed, '')).toBe(
			sellarEtapa1(ETAPA1, '', ed).replace(ed, '')
		);
		/* Las mismas claves, la misma huella: es lo que va fijado en la línea. */
		expect(huellaEtapa1(sellarEtapa1(sellada, lista, ed))).toBe(huellaEtapa1(sellada));
	});

	it('no se sella sin ninguna clave con la que comprobar, ni con algo que no sea una clave', () => {
		expect(() => sellarEtapa1(ETAPA1, `licencias:${ed}`, '')).toThrow();
		expect(() => sellarEtapa1(ETAPA1, `cloud:abc'; rm -rf /; '`, '')).toThrow();
		expect(() => sellarEtapa1(ETAPA1, '', `x' y`)).toThrow();
		expect(() => sellarEtapa1('#!/bin/sh\n', `cloud:${ec}`, '')).toThrow();
	});

	it('la firma ECDSA sale en DER, como la quiere openssl, y la de Ed25519 tal cual', () => {
		for (let i = 0; i < 300; i++) {
			const texto = Buffer.from(`texto ${i}`);
			const f = sign('sha256', texto, { key: p256.privateKey, dsaEncoding: 'ieee-p1363' });
			const der = firmaParaOpenssl(ec, f.toString('base64'))!;
			expect(verify('sha256', texto, { key: p256.publicKey, dsaEncoding: 'der' }, der)).toBe(true);
		}
		const k = generateKeyPairSync('ed25519');
		const pub = k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		const f = sign(null, Buffer.from('x'), k.privateKey);
		expect(firmaParaOpenssl(pub, f.toString('base64'))).toEqual(f);
		expect(firmaParaOpenssl(ec, 'AAAA')).toBeNull();
	});
});

describe('el instalador del sensor remoto', () => {
	const conSensor = (cambios: (r: Release) => void = () => {}) =>
		release((r) => {
			r.sensorRemoto = { ficheros: { 'compose.yml': 'name: sugardaddy-sensor\n' } };
			r.instaladorSensor = {
				huellasSensor: '',
				ficheros: { 'instalar.sh': '#!/usr/bin/env bash\n# sensor\n' }
			};
			r.instaladorSensor.huellasSensor = huellasSensorDe(piezasInstaladorSensor(r)!);
			cambios(r);
		});

	it('se verifica, con sus huellas una sola vez y sin tocar las del nodo', () => {
		const r = conSensor();
		const f = firmarRelease(kino.privada, r);
		expect(verificarRelease(kino.publica, f).ok).toBe(true);
		expect(f.release.split(MARCA_HUELLAS_SENSOR)).toHaveLength(2);
		/* La cadena del nodo no cambia: las etapas 1 de antes siguen instalando nodos. */
		expect(r.instalador!.huellas).toBe(release().instalador!.huellas);
		expect(f.release.split(MARCA_HUELLAS)).toHaveLength(2);
	});

	it('rechaza un guion o un compose que no casan con sus huellas', () => {
		expect(
			comprobar(
				conSensor((r) => {
					r.instaladorSensor!.ficheros['instalar.sh'] = '#!/bin/sh\nreboot\n';
				})
			)
		).toMatchObject({
			ok: false,
			motivo: 'the sensor installer fingerprints do not match its files'
		});
		expect(
			comprobar(
				conSensor((r) => {
					r.sensorRemoto!.ficheros['compose.yml'] = 'services: {}\n';
				})
			)
		).toMatchObject({ ok: false });
	});

	it('sin la configuración del sensor o sin la etapa 1, no vale', () => {
		expect(
			comprobar(
				conSensor((r) => {
					delete r.sensorRemoto;
				})
			).ok
		).toBe(false);
		expect(
			comprobar(
				conSensor((r) => {
					delete r.instalador;
				})
			).ok
		).toBe(false);
	});

	/* El guion viaja firmado con la versión de Cloud: en el árbol de Community no está. */
	const rutaGuion = resolve(process.cwd(), '../../despliegue/sensor-remoto/instalar.sh');
	it.skipIf(!existsSync(rutaGuion))('el guion firmado es el de despliegue/sensor-remoto', () => {
		const guion = readFileSync(rutaGuion, 'utf8');
		expect(guion.startsWith('#!/usr/bin/env bash\n')).toBe(true);
		expect(Buffer.byteLength(guion)).toBeLessThan(64 * 1024);
	});
});

describe('la versión para los nodos (0.32.1)', () => {
	const completa = {
		version: '0.32.1',
		publicada: '2026-11-17T00:00:00.000Z',
		notas: 'n',
		servicios: { consola: 'r/c@sha256:' + 'a'.repeat(64) },
		instalador: {
			huellas: 'v1;',
			ficheros: { 'instalar.sh': 'x'.repeat(1000) },
			etapa1: { texto: 't', firmas: [] }
		},
		instaladorSensor: { huellasSensor: 'v1;', ficheros: { 'instalar.sh': 'y' } },
		commit: 'c'.repeat(40)
	} as unknown as Release;

	it('es la completa sin el instalador ni el del sensor, en el mismo orden', () => {
		const n = releaseParaNodos(completa);
		expect(Object.keys(n)).toEqual(['version', 'publicada', 'notas', 'servicios', 'commit']);
		expect(completa.instalador).toBeDefined();
		expect(motivoVersionNodos(completa, JSON.parse(JSON.stringify(n)))).toBeNull();
	});

	it('no vale otra cosa', () => {
		expect(motivoVersionNodos(completa, { ...releaseParaNodos(completa), notas: 'otra' })).toMatch(
			/not the full version/
		);
		expect(motivoVersionNodos(completa, completa)).toMatch(/not the full version/);
	});

	it('mide como Go, que escapa < > &', () => {
		expect(tamanoParaNodos({ release: 'a<b', firma: 'f' })).toBe(
			JSON.stringify({ release: 'a<b', firma: 'f' }).length + 5
		);
	});
});
