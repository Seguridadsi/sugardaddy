import { describe, expect, it } from 'vitest';
import {
	firmaValida,
	firmarDelegacion,
	firmarLicencia,
	firmarRelease,
	generarClaves,
	huella,
	leerConfianza,
	motivoClaves,
	verificarDelegacion,
	verificarLicencia,
	verificarRelease,
	type Release
} from './index.ts';

const legado = generarClaves();
const cloud = generarClaves();
const cloudReserva = generarClaves();
const community = generarClaves();
const licencias = generarClaves();
const delegaciones = generarClaves();

const D = '@sha256:' + 'a'.repeat(64);
const releaseCloud = (extra: Partial<Release> = {}): Release => ({
	version: '0.25.0',
	publicada: '2026-11-10T10:00:00Z',
	notas: 'x',
	servicios: { consola: `ejemplo.azurecr.io/sugardaddy-consola${D}` },
	...extra
});
const releaseCommunity = (): Release => ({
	version: '0.25.0',
	publicada: '2026-11-10T10:00:00Z',
	notas: 'x',
	servicios: { consola: `ghcr.io/seguridadsi/sugardaddy-consola${D}` }
});
const lista = (...p: [string, { publica: string }][]) =>
	p.map(([uso, k]) => `${uso}:${k.publica}`).join(',');

describe('la lista de claves de confianza', () => {
	it('lee uso:clave y no da confianza por lo que no entiende', () => {
		const c = leerConfianza(
			`cloud:${cloud.publica}, otra:${community.publica},licencias:no-es-clave,licencias:${licencias.publica}`,
			legado.publica
		);
		expect(c.claves).toEqual([
			{ uso: 'cloud', publica: cloud.publica },
			{ uso: 'licencias', publica: licencias.publica }
		]);
		expect(c.legado).toBe(legado.publica);
		expect(leerConfianza('', '').legado).toBeNull();
	});

	it('motivoClaves rechaza usos y claves que no valen', () => {
		expect(motivoClaves(lista(['cloud', cloud], ['community', community]))).toBeNull();
		expect(motivoClaves('')).toBeNull();
		expect(motivoClaves(`otra:${cloud.publica}`)).toMatch(/unknown key use/);
		expect(motivoClaves('cloud:AAAA')).toMatch(/not an Ed25519/);
	});
});

describe('versiones con varias firmas', () => {
	it('un nodo de antes, que solo tiene la de legado, sigue comprobando la versión de transición', () => {
		const f = firmarRelease(legado.privada, releaseCloud(), [cloud]);
		expect(f.firmas).toEqual([{ clave: huella(cloud.publica), firma: expect.any(String) }]);
		const v = verificarRelease(legado.publica, f);
		expect(v.ok && v.firmadaCon).toBe(huella(legado.publica));
	});

	it('un nodo con la lista nueva y sin legado la comprueba por la firma nueva', () => {
		const f = firmarRelease(legado.privada, releaseCloud(), [cloud]);
		const v = verificarRelease(leerConfianza(lista(['cloud', cloud]), ''), f);
		expect(v.ok && v.firmadaCon).toBe(huella(cloud.publica));
	});

	it('la de reserva también vale', () => {
		const f = firmarRelease(cloudReserva.privada, releaseCloud());
		const c = leerConfianza(lista(['cloud', cloud], ['cloud', cloudReserva]), '');
		expect(verificarRelease(c, f).ok).toBe(true);
	});

	it('una clave de otro uso no sirve para una versión', () => {
		const c = leerConfianza(
			lista(['community', community], ['licencias', licencias], ['delegaciones', delegaciones]),
			''
		);
		for (const k of [community, licencias, delegaciones])
			expect(verificarRelease(c, firmarRelease(k.privada, releaseCloud()))).toMatchObject({
				ok: false
			});
		/* La de Community sí, para una de Community. */
		expect(verificarRelease(c, firmarRelease(community.privada, releaseCommunity())).ok).toBe(true);
	});

	it('una firma en `firmas` con la huella de una clave que no es del uso no cuenta', () => {
		const f = firmarRelease(generarClaves().privada, releaseCloud(), [licencias]);
		const c = leerConfianza(lista(['cloud', cloud], ['licencias', licencias]), '');
		expect(verificarRelease(c, f).ok).toBe(false);
	});

	it('sin ninguna clave para su uso, lo dice', () => {
		const v = verificarRelease(leerConfianza(lista(['community', community]), ''), {
			release: JSON.stringify(releaseCloud()),
			firma: 'AAAA'
		});
		expect(v).toEqual({ ok: false, motivo: 'there is no trusted key to check this version' });
	});
});

describe('confianza, catálogo y commit en la versión', () => {
	const firmada = (r: Release) =>
		verificarRelease(legado.publica, firmarRelease(legado.privada, r));

	it('acepta una confianza con una clave de su propio uso', () => {
		const r = releaseCloud({
			confianza: { claves: lista(['cloud', cloud], ['licencias', licencias]) }
		});
		expect(firmada(r).ok).toBe(true);
	});

	it('no acepta una confianza que deje su edición sin clave', () => {
		const r = releaseCloud({ confianza: { claves: lista(['community', community]) } });
		expect(firmada(r)).toMatchObject({ ok: false, motivo: /without a key/ });
		expect(
			firmada(
				releaseCloud({
					confianza: { claves: `cloud:${cloud.publica}`, retirarLegado: 'si' as never }
				})
			)
		).toMatchObject({ ok: false });
	});

	it('retirar el legado exige claves de licencias y delegaciones (A13)', () => {
		const solo = releaseCloud({
			confianza: { claves: lista(['cloud', cloud]), retirarLegado: true }
		});
		expect(firmada(solo)).toMatchObject({ ok: false, motivo: /retiring the legacy key/ });
		const todas = releaseCloud({
			confianza: {
				claves: lista(['cloud', cloud], ['licencias', licencias], ['delegaciones', delegaciones]),
				retirarLegado: true
			}
		});
		expect(firmada(todas).ok).toBe(true);
	});

	it('valida la forma del catálogo y del commit', () => {
		const h = 'b'.repeat(64);
		expect(
			firmada(releaseCloud({ catalogo: { cowrie: [h, 'c'.repeat(64)] }, commit: 'd'.repeat(40) }))
				.ok
		).toBe(true);
		for (const catalogo of [{ cowrie: [] }, { '../x': [h] }, { cowrie: ['corta'] }, []] as never[])
			expect(firmada(releaseCloud({ catalogo })).ok).toBe(false);
		expect(firmada(releaseCloud({ commit: 'main' })).ok).toBe(false);
	});
});

describe('licencias y delegaciones con claves por uso', () => {
	const ahora = Date.parse('2026-11-10T00:00:00Z');
	const licencia = {
		tipo: 'licencia' as const,
		version: 1 as const,
		cliente: 'kebaps',
		nodo: 'nodo-1',
		nodoClave: 'AAAA',
		modulos: ['smb'],
		marca: 'm',
		emitida: '2026-11-01T00:00:00Z',
		caduca: '2027-11-01T00:00:00Z'
	};
	const delegacion = {
		tipo: 'delegacion-licencias' as const,
		version: 1 as const,
		msp: 'msp-uno',
		clavePublica: generarClaves().publica,
		modulos: ['smb'],
		emitida: '2026-11-01T00:00:00Z',
		caduca: '2027-11-01T00:00:00Z'
	};

	it('una licencia con doble firma vale para lo de antes y para lo nuevo', () => {
		const f = firmarLicencia(legado.privada, licencia, [licencias]);
		expect(verificarLicencia(legado.publica, f, ahora).ok).toBe(true);
		expect(verificarLicencia(leerConfianza(lista(['licencias', licencias]), ''), f, ahora).ok).toBe(
			true
		);
	});

	it('la clave de licencias no firma delegaciones, ni la de Cloud licencias', () => {
		const c = leerConfianza(lista(['licencias', licencias], ['cloud', cloud]), '');
		expect(verificarDelegacion(c, firmarDelegacion(licencias.privada, delegacion), ahora).ok).toBe(
			false
		);
		expect(verificarLicencia(c, firmarLicencia(cloud.privada, licencia), ahora).ok).toBe(false);
		const d = leerConfianza(lista(['delegaciones', delegaciones]), '');
		expect(
			verificarDelegacion(d, firmarDelegacion(delegaciones.privada, delegacion), ahora).ok
		).toBe(true);
	});
});

describe('el vector común con Go (vectores/confianza.json)', () => {
	it('quien solo confía en PUBLICACION_CLAVES acepta la versión, la licencia y la de MSP', async () => {
		const { readFileSync } = await import('node:fs');
		const v = JSON.parse(
			readFileSync(new URL('./vectores/confianza.json', import.meta.url), 'utf8')
		);
		const c = leerConfianza(v.claves, '');
		const ahora = Date.parse('2026-11-10T00:00:00Z');
		expect(verificarRelease(c, v.release).ok).toBe(true);
		expect(verificarLicencia(c, v.licencia, ahora).ok).toBe(true);
		expect(verificarLicencia(c, v.licenciaDelegada, ahora)).toMatchObject({
			ok: true,
			msp: 'msp-vector'
		});
	});
});

describe('claves ECDSA P-256 como las del Key Vault (vectores/confianza-ec.json)', () => {
	it('acepta versión, licencia y licencia de MSP, también con la nueva sola en firma', async () => {
		const { readFileSync } = await import('node:fs');
		const v = JSON.parse(
			readFileSync(new URL('./vectores/confianza-ec.json', import.meta.url), 'utf8')
		);
		const c = leerConfianza(v.claves, '');
		expect(c.claves).toHaveLength(3);
		const ahora = Date.parse('2026-11-10T00:00:00Z');
		expect(verificarRelease(c, v.release).ok).toBe(true);
		expect(verificarRelease(c, v.releaseSinLegado).ok).toBe(true);
		expect(verificarLicencia(c, v.licencia, ahora).ok).toBe(true);
		expect(verificarLicencia(c, v.licenciaDelegada, ahora)).toMatchObject({
			ok: true,
			msp: 'msp-vector'
		});
		/* La de Cloud no vale para la licencia, ni la firma tocada. */
		const soloCloud = leerConfianza(v.claves.split(',')[0], '');
		expect(verificarLicencia(soloCloud, v.licencia, ahora).ok).toBe(false);
		const tocada = {
			...v.releaseSinLegado,
			release: v.releaseSinLegado.release.replace('vector', 'vectoR')
		};
		expect(verificarRelease(c, tocada).ok).toBe(false);
	});

	it('una ECDSA en DER (no r||s) o de otra curva no se acepta', async () => {
		const { generateKeyPairSync, sign } = await import('node:crypto');
		const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		const pub = k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		const der = sign('sha256', Buffer.from('x'), k.privateKey).toString('base64');
		expect(firmaValida(pub, 'x', der)).toBe(false);
		const raw = sign('sha256', Buffer.from('x'), { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
		expect(firmaValida(pub, 'x', raw.toString('base64'))).toBe(true);
		const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
			.publicKey.export({ format: 'der', type: 'spki' })
			.toString('base64');
		expect(motivoClaves(`cloud:${p384}`)).toMatch(/not an Ed25519 or ECDSA P-256/);
	});
});
