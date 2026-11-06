import { describe, expect, it } from 'vitest';
import {
	CLIENTE_REGISTRO,
	MODULOS_GRATIS,
	MODULOS_REGISTRO,
	NODO_CLAVE_REGISTRO,
	NODO_REGISTRO,
	PREFIJO_CODIGO,
	TAM_MAX_CODIGO,
	codificarCodigo,
	decodificarCodigo,
	esDePago,
	esDeRegistro,
	firmarDelegacion,
	firmarLicencia,
	firmarLicenciaDelegada,
	generarClaves,
	licenciaDeRegistro,
	motivoLicencia,
	type Delegacion,
	type Licencia
} from './index.ts';

const kino = generarClaves();
const panel = generarClaves();
const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const licencia = (l: Partial<Licencia> = {}): Licencia => ({
	tipo: 'licencia',
	version: 1,
	cliente: CLIENTE_REGISTRO,
	nodo: NODO_REGISTRO,
	nodoClave: NODO_CLAVE_REGISTRO,
	modulos: [...MODULOS_REGISTRO],
	marca: 'r-prueba',
	emitida: dias(-1),
	caduca: dias(300),
	...l
});
const certificado = (d: Partial<Delegacion> = {}) =>
	firmarDelegacion(kino.privada, {
		tipo: 'delegacion-licencias',
		version: 1,
		msp: 'registro',
		clavePublica: panel.publica,
		modulos: [...MODULOS_REGISTRO],
		emitida: dias(-2),
		caduca: dias(400),
		...d
	});
const firmada = (l: Partial<Licencia> = {}, d: Partial<Delegacion> = {}) =>
	firmarLicenciaDelegada(panel.privada, licencia(l), certificado(d));

describe('los planes', () => {
	it('sin registro, solo cowrie; las de registro llevan candado y no son gratis', () => {
		expect([...MODULOS_GRATIS]).toEqual(['cowrie']);
		expect(esDePago('cowrie')).toBe(false);
		for (const m of MODULOS_REGISTRO) {
			expect(esDePago(m), m).toBe(true);
			expect(esDeRegistro(m), m).toBe(true);
			expect(MODULOS_GRATIS.has(m), m).toBe(false);
		}
		expect(esDePago('mysql')).toBe(true);
		expect(esDeRegistro('mysql')).toBe(false);
	});

	it('los campos fijos de la licencia de registro pasan la validación', () => {
		expect(motivoLicencia(licencia())).toBeNull();
	});
});

describe('el código de activación', () => {
	const c = { licencia: firmada(), token: 'a'.repeat(43), correo: 'a@b.es' };

	it('ida y vuelta, también con los saltos de línea de copiar y pegar', () => {
		const texto = codificarCodigo(c);
		expect(texto.startsWith(PREFIJO_CODIGO)).toBe(true);
		expect(texto.length).toBeLessThan(TAM_MAX_CODIGO);
		expect(decodificarCodigo(texto)).toEqual(c);
		expect(decodificarCodigo(`  ${texto.slice(0, 40)}\n${texto.slice(40)}\n`)).toEqual(c);
	});

	it.each([
		['vacío', ''],
		['otro prefijo', 'SDR2.abc'],
		['no es JSON', `${PREFIJO_CODIGO}AAAA`],
		['enorme', `${PREFIJO_CODIGO}${'A'.repeat(TAM_MAX_CODIGO)}`],
		['null', PREFIJO_CODIGO + Buffer.from('null').toString('base64url')],
		[
			'token corto',
			PREFIJO_CODIGO + Buffer.from(JSON.stringify({ ...c, token: 'x' })).toString('base64url')
		],
		[
			'sin licencia',
			PREFIJO_CODIGO +
				Buffer.from(JSON.stringify({ token: c.token, correo: c.correo })).toString('base64url')
		],
		[
			'correo enorme',
			PREFIJO_CODIGO +
				Buffer.from(JSON.stringify({ ...c, correo: 'x'.repeat(300) })).toString('base64url')
		]
	])('rechaza %s', (_, texto) => {
		expect(decodificarCodigo(texto)).toBeNull();
	});
});

describe('licenciaDeRegistro', () => {
	it('vale la cadena completa', () => {
		const v = licenciaDeRegistro(kino.publica, firmada());
		expect(v.ok).toBe(true);
	});

	it.each([
		['un MSP de verdad', () => firmada({}, { msp: 'msp-acme' })],
		['una licencia de Cloud', () => firmarLicencia(kino.privada, licencia())],
		[
			'un módulo fuera de la lista, aunque el certificado lo cubra',
			() => firmada({ modulos: ['smb', 'mysql'] }, { modulos: ['smb', 'mysql'] })
		],
		[
			'otro firmante',
			() => firmarLicenciaDelegada(generarClaves().privada, licencia(), certificado())
		],
		[
			'un certificado de otra clave de publicación',
			() =>
				firmarLicenciaDelegada(
					panel.privada,
					licencia(),
					firmarDelegacion(generarClaves().privada, {
						tipo: 'delegacion-licencias',
						version: 1,
						msp: 'registro',
						clavePublica: panel.publica,
						modulos: [...MODULOS_REGISTRO],
						emitida: dias(-2),
						caduca: dias(400)
					})
				)
		]
	])('no vale %s', (_, f) => {
		expect(licenciaDeRegistro(kino.publica, f()).ok).toBe(false);
		/* Ni pasando por alto las fechas. */
		expect(licenciaDeRegistro(kino.publica, f(), 0).ok).toBe(false);
	});

	it('caducada no vale, salvo con ahora=0, que solo mira si es auténtica', () => {
		const f = firmada({ emitida: dias(-30), caduca: dias(-1) });
		const v = licenciaDeRegistro(kino.publica, f);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.motivo).toMatch(/expired/);
		expect(licenciaDeRegistro(kino.publica, f, 0).ok).toBe(true);
	});

	it('con el certificado caducado tampoco, y el motivo también lo dice', () => {
		const v = licenciaDeRegistro(kino.publica, firmada({}, { caduca: dias(-1) }));
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.motivo).toMatch(/expired/);
	});
});
