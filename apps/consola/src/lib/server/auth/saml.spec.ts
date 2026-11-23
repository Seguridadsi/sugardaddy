/*
 * SAML 2.0 (saml.ts) contra un proveedor falso con claves de verdad
 * (saml-idp-falso.ts): la ida, los metadatos de los dos lados y cada forma de
 * torcer la respuesta que tiene que acabar rechazada.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import {
	CacheAcotada,
	comprobarIdp,
	correoSaml,
	crearSaml,
	cuerpoCert,
	datosCert,
	generarClavesSp,
	huboMfaSaml,
	leerMetadatosIdp,
	metadatosSp,
	urlDeIda,
	validarRespuesta,
	type ConfigSaml
} from './saml';
import {
	ENTIDAD_IDP,
	SSO_IDP,
	metadatosIdp,
	parDeClaves,
	respuestaSaml,
	type OpcionesRespuesta,
	type ParClaves
} from './saml-idp-falso';

const ORIGEN = 'https://consola.banco.example';
const ACS = `${ORIGEN}/auth/saml/acs`;
const SP = `${ORIGEN}/auth/saml/metadata`;
const MFA = 'http://schemas.microsoft.com/claims/multipleauthn';

let idp: ParClaves;
let otro: ParClaves;
let c: ConfigSaml;

beforeAll(async () => {
	idp = await parDeClaves();
	otro = await parDeClaves('Otro');
	const sp = await generarClavesSp('consola');
	c = {
		entidad: ENTIDAD_IDP,
		sso: SSO_IDP,
		certs: [cuerpoCert(idp.cert)],
		spEntidad: SP,
		acs: ACS,
		claveSp: sp.clave,
		certSp: sp.cert,
		contextos: [],
		pedirContexto: false,
		exigirCifrado: false
	};
});

/* Una ida de verdad: devuelve el saml, la caché y el id de la petición. */
async function ida(conf = c) {
	const cache = new CacheAcotada();
	const saml = crearSaml(conf, cache);
	const url = new URL(await urlDeIda(saml, 'relay-1'));
	const xml = inflateRawSync(
		Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')
	).toString();
	const id = xml.match(/ID="([^"]+)"/)![1];
	return { saml, cache, url, xml, id };
}

const resp = (id: string, o: Partial<OpcionesRespuesta> = {}) =>
	respuestaSaml({
		claves: idp,
		acs: ACS,
		audiencia: SP,
		inResponseTo: id,
		contexto: MFA,
		atributos: { email: ['Ana@Banco.es'], groups: ['sd-admins', 'todos'] },
		...o
	});

describe('metadatos', () => {
	it('lee los del proveedor: entidad, entrada por HTTP-Redirect y certificado de firma', () => {
		const m = leerMetadatosIdp(metadatosIdp(idp.cert));
		expect(m).toEqual({ entidad: ENTIDAD_IDP, sso: SSO_IDP, certs: [cuerpoCert(idp.cert)] });
		expect(comprobarIdp(m as never)).toBeNull();
		expect(datosCert(cuerpoCert(idp.cert))?.huella).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
	});

	it('rechaza lo que no son metadatos de proveedor, con DOCTYPE o sin firma', () => {
		expect(leerMetadatosIdp('no es xml <')).toHaveProperty('error');
		expect(
			leerMetadatosIdp(
				'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'
			)
		).toHaveProperty('error');
		expect(
			leerMetadatosIdp(
				'<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"><SPSSODescriptor/></EntityDescriptor>'
			)
		).toHaveProperty('error');
		const sinCert = metadatosIdp(idp.cert).replace(
			/<md:KeyDescriptor[\s\S]*?<\/md:KeyDescriptor>/,
			''
		);
		expect(leerMetadatosIdp(sinCert)).toEqual({ error: expect.stringMatching(/certificate/) });
		expect(comprobarIdp({ entidad: 'x', sso: 'http://idp.example.com', certs: ['x'] })).toMatch(
			/https/
		);
	});

	it('los del SP llevan la entidad, el ACS y el certificado', () => {
		const xml = metadatosSp(c);
		expect(xml).toContain(`entityID="${SP}"`);
		expect(xml).toContain(`Location="${ACS}"`);
		expect(xml).toContain('WantAssertionsSigned="true"');
		expect(xml).toContain('AuthnRequestsSigned="true"');
		expect(xml).toContain('use="encryption"');
		expect(xml).toContain('<Signature');
		expect(xml).toContain(cuerpoCert(c.certSp).slice(0, 40));
	});
});

describe('ida', () => {
	it('va al proveedor firmada, con el ACS y sin contexto pedido de serie', async () => {
		const { url, xml } = await ida();
		expect(url.origin + url.pathname).toBe(SSO_IDP);
		expect(url.searchParams.get('RelayState')).toBe('relay-1');
		expect(url.searchParams.get('Signature')).toBeTruthy();
		expect(url.searchParams.get('SigAlg')).toContain('rsa-sha256');
		expect(xml).toContain(`AssertionConsumerServiceURL="${ACS}"`);
		expect(xml).not.toContain('RequestedAuthnContext');
	});

	it('pide el contexto de MFA si se configura', async () => {
		const { xml } = await ida({ ...c, contextos: [MFA], pedirContexto: true });
		expect(xml).toContain('RequestedAuthnContext');
		expect(xml).toContain(MFA);
	});

	it('la caché está acotada', async () => {
		const k = new CacheAcotada(1000, 2);
		await k.saveAsync('a', '1');
		await k.saveAsync('b', '1');
		await expect(k.saveAsync('c', '1')).rejects.toThrow(/too many/);
		expect(await k.consumeAsync('a')).toBe('1');
		expect(await k.consumeAsync('a')).toBeNull();
	});
});

describe('respuesta', () => {
	it('una buena: NameID, contexto, atributos, correo y MFA', async () => {
		const { saml, id } = await ida();
		const a = await validarRespuesta(saml, c, await resp(id), 'relay-1');
		expect(a.nameId).toBe('u-1');
		expect(a.contextos).toEqual([MFA]);
		expect(a.atributos.groups).toEqual(['sd-admins', 'todos']);
		expect(correoSaml(a, '')).toBe('ana@banco.es');
		expect(huboMfaSaml(a)).toBe(true);
		expect(
			huboMfaSaml({ ...a, contextos: ['urn:oasis:names:tc:SAML:2.0:ac:classes:Password'] })
		).toBe(false);
		expect(huboMfaSaml({ ...a, contextos: ['urn:okta:mfa'] }, ['urn:okta:mfa'])).toBe(true);
	});

	it('la misma respuesta no vale dos veces', async () => {
		const { saml, id } = await ida();
		const r = await resp(id);
		await validarRespuesta(saml, c, r, 'relay-1');
		await expect(validarRespuesta(saml, c, r, 'relay-1')).rejects.toThrow();
	});

	it('la misma aserción, en otra respuesta a otra ida, tampoco', async () => {
		const cache = new CacheAcotada();
		const saml = crearSaml(c, cache);
		const id1 = new URL(await urlDeIda(saml, 'r'));
		void id1;
		const ids = [...(await Promise.all([1, 2].map(() => urlDeIda(saml, 'r'))))].map(
			(u) =>
				inflateRawSync(Buffer.from(new URL(u).searchParams.get('SAMLRequest')!, 'base64'))
					.toString()
					.match(/ID="([^"]+)"/)![1]
		);
		await validarRespuesta(saml, c, await resp(ids[0], { idAsercion: '_fija' }), 'r');
		await expect(
			validarRespuesta(saml, c, await resp(ids[1], { idAsercion: '_fija' }), 'r')
		).rejects.toThrow();
	});

	it('sin ida desde la consola (iniciada por el proveedor o InResponseTo inventado), no', async () => {
		const { saml } = await ida();
		await expect(validarRespuesta(saml, c, await resp('_inventado'), 'relay-1')).rejects.toThrow();
		await expect(
			validarRespuesta(saml, c, await resp('', { inResponseTo: undefined }), 'relay-1')
		).rejects.toThrow();
	});

	const malas: [string, Partial<OpcionesRespuesta>, RegExp?][] = [
		['firmada con otra clave', { claves: undefined as never }],
		['aserción sin firmar', { firmarAsercion: false }],
		['respuesta sin firmar', { firmarRespuesta: false }],
		['otra audiencia', { audiencia: 'https://otra.example/sp' }],
		['otro emisor', { emisor: 'https://otro-idp.example' }],
		['otro destino', { destino: 'https://otra.example/acs' }, /Destination/],
		['otro receptor', { receptor: 'https://otra.example/acs' }, /bearer/],
		['vieja (fuera del margen de reloj)', { desfase: -10 * 60_000 }],
		['del futuro (fuera del margen de reloj)', { desfase: 10 * 60_000 }],
		['error del proveedor', { estado: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }]
	];
	for (const [nombre, o, error] of malas)
		it(`rechaza: ${nombre}`, async () => {
			const { saml, id } = await ida();
			const r = await resp(
				id,
				o.claves === undefined && 'claves' in o ? { ...o, claves: otro } : o
			);
			await expect(validarRespuesta(saml, c, r, 'relay-1')).rejects.toThrow(error ?? /./);
		});

	it('dentro del margen de reloj, sí', async () => {
		const { saml, id } = await ida();
		await expect(
			validarRespuesta(saml, c, await resp(id, { desfase: 60_000 }), 'relay-1')
		).resolves.toBeTruthy();
	});

	it('acepta el certificado nuevo durante una rotación (dos en los metadatos)', async () => {
		const conf = { ...c, certs: [cuerpoCert(otro.cert), cuerpoCert(idp.cert)] };
		const { saml, id } = await ida(conf);
		await expect(validarRespuesta(saml, conf, await resp(id), 'relay-1')).resolves.toBeTruthy();
	});

	it('descifra una aserción cifrada para el certificado del SP', async () => {
		const conf = { ...c, exigirCifrado: true };
		const { saml, id } = await ida(conf);
		const a = await validarRespuesta(
			saml,
			conf,
			await resp(id, { cifrarPara: c.certSp }),
			'relay-1'
		);
		expect(a.atributos.groups).toEqual(['sd-admins', 'todos']);
	});

	it('exigir cifrado rechaza una aserción en claro', async () => {
		const conf = { ...c, exigirCifrado: true };
		const { saml, id } = await ida(conf);
		await expect(validarRespuesta(saml, conf, await resp(id), 'relay-1')).rejects.toThrow(
			/encrypted/
		);
	});
});
