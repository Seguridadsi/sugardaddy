import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	firmarCon,
	firmarLicencia,
	firmanteDePrivada,
	generarClaves,
	huellaLicencia,
	revoca,
	revocacionDe,
	verificarLicencia,
	verificarRevocacion,
	type Licencia,
	type Revocacion
} from './index.ts';

const kino = generarClaves();
const otra = generarClaves();
const nodo = generarClaves();

const licencia = (cambios: Partial<Licencia> = {}): Licencia => ({
	tipo: 'licencia',
	version: 1,
	cliente: 'acme',
	nodo: 'acme-nodo-1',
	nodoClave: nodo.publica,
	modulos: ['mysql'],
	marca: 'acme-7f3a',
	emitida: '2026-10-20T09:00:00.000Z',
	caduca: '2026-12-04T09:00:00.000Z',
	...cambios
});

const revocacion = (cambios: Partial<Revocacion> = {}): Revocacion => ({
	tipo: 'revocacion',
	version: 1,
	cliente: 'acme',
	hasta: '2026-11-15T10:00:00.000Z',
	emitida: '2026-11-15T10:00:00.000Z',
	...cambios
});

const firmar = (r: object, privada = kino.privada) => {
	const texto = JSON.stringify(r);
	return { revocacion: texto, ...firmarCon(texto, firmanteDePrivada(privada)) };
};

describe('revocación de licencias', () => {
	it('firmada con la clave de licencias, se acepta', () => {
		expect(verificarRevocacion(kino.publica, firmar(revocacion()))).toEqual({
			ok: true,
			revocacion: revocacion()
		});
	});

	it('firmada con otra clave, o sin forma, no', () => {
		expect(verificarRevocacion(kino.publica, firmar(revocacion(), otra.privada))).toEqual({
			ok: false,
			motivo: 'not signed by SeguridadSI'
		});
		expect(verificarRevocacion(kino.publica, { revocacion: 1 }).ok).toBe(false);
		expect(
			verificarRevocacion(kino.publica, firmar({ ...revocacion(), tipo: 'licencia' }))
		).toEqual({ ok: false, motivo: 'not a revocation' });
		expect(
			verificarRevocacion(kino.publica, firmar(revocacion({ licencia: 'no-es-hex' })))
		).toEqual({ ok: false, motivo: 'malformed license fingerprint' });
	});

	it('sin clave de confianza no se comprueba nada', () => {
		expect(verificarRevocacion('', firmar(revocacion())).ok).toBe(false);
	});

	it('alcanza a las licencias del cliente emitidas hasta su fecha, no a las de después', () => {
		const r = revocacion();
		const t = JSON.stringify(licencia());
		expect(revoca(r, licencia(), t)).toBe(true);
		const nueva = licencia({ emitida: '2026-11-16T09:00:00.000Z' });
		expect(revoca(r, nueva, JSON.stringify(nueva))).toBe(false);
		const deOtro = licencia({ cliente: 'otro' });
		expect(revoca(r, deOtro, JSON.stringify(deOtro))).toBe(false);
	});

	it('con nodo o con huella, solo esa', () => {
		const l = licencia();
		const t = JSON.stringify(l);
		expect(revoca(revocacion({ nodo: 'acme-nodo-2' }), l, t)).toBe(false);
		expect(revoca(revocacion({ nodo: 'acme-nodo-1' }), l, t)).toBe(true);
		expect(revoca(revocacion({ licencia: huellaLicencia(t) }), l, t)).toBe(true);
		expect(revoca(revocacion({ licencia: '0'.repeat(64) }), l, t)).toBe(false);
	});

	it('revocacionDe ignora las que no se comprueban y encuentra la que vale', () => {
		const f = firmarLicencia(kino.privada, licencia());
		const v = verificarLicencia(kino.publica, f, Date.parse('2026-10-21T00:00:00Z'));
		if (!v.ok) throw new Error(v.motivo);
		const falsa = firmar(revocacion(), otra.privada);
		expect(revocacionDe(kino.publica, [falsa], f, v.licencia)).toBeNull();
		expect(revocacionDe(kino.publica, 'no-es-lista', f, v.licencia)).toBeNull();
		expect(revocacionDe(kino.publica, [falsa, firmar(revocacion())], f, v.licencia)).toEqual(
			revocacion()
		);
	});

	it('las revocaciones junto a la licencia no cambian lo que verifica la licencia', () => {
		const f = firmarLicencia(kino.privada, licencia());
		const con = { ...f, revocaciones: [firmar(revocacion())] };
		expect(verificarLicencia(kino.publica, con, Date.parse('2026-10-21T00:00:00Z')).ok).toBe(true);
	});

	/* El mismo vector que comprueba modulos/comun/licencia (TestVectorRevocacion). */
	it('vector compartido con el Go', () => {
		const v = JSON.parse(
			readFileSync(new URL('./vectores/revocacion.json', import.meta.url), 'utf8')
		);
		const l = verificarLicencia(v.clavePublicacion, v.firmada, Date.parse('2026-11-02T00:00:00Z'));
		if (!l.ok) throw new Error(l.motivo);
		expect(revocacionDe(v.clavePublicacion, [v.noLaRevoca], v.firmada, l.licencia)).toBeNull();
		expect(revocacionDe(v.clavePublicacion, [v.laRevoca], v.firmada, l.licencia)?.nodo).toBe(
			'vector-nodo-1'
		);
	});
});
