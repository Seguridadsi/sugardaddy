/*
 * La madurez del catálogo (madurez.ts, D11): solo la de una versión firmada de la versión del
 * nodo, comprobada con sus claves. Lo que no se comprueba no se enseña.
 */
import { describe, expect, it, vi } from 'vitest';
import { confianzaDelEntorno, firmarRelease, generarClaves, type Release } from '@sugardaddy/canal';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('./db', () => ({ db: {}, schema: {} }));
vi.mock('./canal', () => ({ versionFirmadaDe: async () => null }));
vi.mock('./consultas', () => ({ cabecera: async () => ({ cliente: { version: '0.33.0' } }) }));

const { madurezDeFirmadas, estadoDe } = await import('./madurez');

const publicacion = generarClaves();
const clave = confianzaDelEntorno({ PUBLICACION_CLAVE_PUBLICA: publicacion.publica });
const madurez = {
	cowrie: { version: '0.2.4', hecha: true, probada: '2026-11-18', banco: 'probar-trampa' }
};
const release = (version: string, extra: Partial<Release> = {}): Release => ({
	version,
	publicada: '2026-11-19T10:00:00.000Z',
	notas: 'prueba',
	servicios: { consola: `ghcr.io/seguridadsi/sugardaddy-consola@sha256:${'a'.repeat(64)}` },
	...extra
});

describe('madurezDeFirmadas', () => {
	it('la de la versión del nodo, firmada', () => {
		const f = firmarRelease(publicacion.privada, release('0.33.0', { madurez }));
		expect(madurezDeFirmadas([undefined, f], clave, '0.33.0')).toEqual({
			version: '0.33.0',
			madurez
		});
	});

	it('otra versión no vale: hay que pedirla', () => {
		const f = firmarRelease(publicacion.privada, release('0.32.2', { madurez }));
		expect(madurezDeFirmadas([f], clave, '0.33.0')).toBeUndefined();
	});

	it('firmada con otra clave, o tocada, no vale', () => {
		const otra = firmarRelease(generarClaves().privada, release('0.33.0', { madurez }));
		expect(madurezDeFirmadas([otra], clave, '0.33.0')).toBeUndefined();
		const f = firmarRelease(publicacion.privada, release('0.33.0', { madurez }));
		const tocada = { ...f, release: f.release.replace('"probada":"2026-11-18"', '"probada":null') };
		expect(madurezDeFirmadas([tocada], clave, '0.33.0')).toBeUndefined();
	});

	it('una versión de antes de la D11: es la buena, pero no dice la madurez', () => {
		const f = firmarRelease(publicacion.privada, release('0.33.0'));
		expect(madurezDeFirmadas([f], clave, '0.33.0')).toBeNull();
	});
});

describe('estadoDe', () => {
	const vista = { version: '0.33.0', madurez };
	it('sin madurez, o de un partner, no se sabe', () => {
		expect(estadoDe(null, { id: 'cowrie', versionModulo: '0.2.4' })).toBeNull();
		expect(estadoDe(vista, { id: 'cowrie', versionModulo: '0.2.4', dePartner: true })).toBeNull();
	});
	it('con madurez, el de la versión firmada', () => {
		expect(estadoDe(vista, { id: 'cowrie', versionModulo: '0.2.4' })?.nivel).toBe('soportada');
		expect(estadoDe(vista, { id: 'otra', versionModulo: '0.1.0' })?.nivel).toBe('sin-publicar');
	});
});
