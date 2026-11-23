/*
 * Un proveedor de identidad SAML falso, solo para las pruebas (lo importan los
 * *.spec.ts, nunca la consola): una clave y un certificado propios y una
 * respuesta SAML firmada de verdad con xml-crypto, con cada pieza que se puede
 * torcer para comprobar que la consola la rechaza (firma, audiencia, destino,
 * InResponseTo, fechas, contexto de autenticación, atributos…).
 */
import 'reflect-metadata';
import { createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { SignedXml } from 'xml-crypto';
import { encrypt } from 'xml-encryption';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = {
	name: 'RSASSA-PKCS1-v1_5',
	hash: 'SHA-256',
	publicExponent: new Uint8Array([1, 0, 1]),
	modulusLength: 2048
};

export type ParClaves = { clave: string; cert: string };

/* Un par clave privada (PKCS#8) y certificado autofirmado, en PEM. */
export async function parDeClaves(cn = 'IdP falso', dias = 365): Promise<ParClaves> {
	const claves = (await webcrypto.subtle.generateKey(ALG, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const ahora = Date.now();
	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: '01' + randomBytes(8).toString('hex'),
		name: `CN=${cn}`,
		notBefore: new Date(ahora - 60_000),
		notAfter: new Date(ahora + dias * 86_400_000),
		signingAlgorithm: ALG,
		keys: claves
	});
	const pk = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', claves.privateKey));
	const clave = createPrivateKey({ key: pk, format: 'der', type: 'pkcs8' })
		.export({ type: 'pkcs8', format: 'pem' })
		.toString();
	return { clave, cert: cert.toString('pem') };
}

const cuerpoPem = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

export const ENTIDAD_IDP = 'https://idp.example.com/saml/metadata';
export const SSO_IDP = 'https://idp.example.com/saml/sso';

/* Los metadatos que publicaría el proveedor. */
export function metadatosIdp(cert: string, sso = SSO_IDP, entidad = ENTIDAD_IDP) {
	return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entidad}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cuerpoPem(cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${sso}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sso}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

const esc = (t: string) =>
	t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type OpcionesRespuesta = {
	claves: ParClaves;
	acs: string;
	audiencia: string;
	inResponseTo?: string;
	emisor?: string;
	nameId?: string;
	formatoNameId?: string;
	contexto?: string;
	atributos?: Record<string, string[]>;
	/* Desplaza todas las fechas (ms): negativo, una respuesta vieja. */
	desfase?: number;
	destino?: string;
	receptor?: string;
	firmarAsercion?: boolean;
	firmarRespuesta?: boolean;
	estado?: string;
	idAsercion?: string;
	/* Certificado del SP (PEM): la aserción va cifrada para él. */
	cifrarPara?: string;
};

/* Una Response SAML 2.0, firmada como la mandaría el proveedor, en base64 (HTTP-POST). */
export async function respuestaSaml(o: OpcionesRespuesta): Promise<string> {
	const t = (ms: number) => new Date(Date.now() + (o.desfase ?? 0) + ms).toISOString();
	const idR = '_r' + randomBytes(10).toString('hex');
	const idA = o.idAsercion ?? '_a' + randomBytes(10).toString('hex');
	const emisor = o.emisor ?? ENTIDAD_IDP;
	const irt = o.inResponseTo ? ` InResponseTo="${esc(o.inResponseTo)}"` : '';
	const estado = o.estado ?? 'urn:oasis:names:tc:SAML:2.0:status:Success';
	const atributos = Object.entries(o.atributos ?? {})
		.map(
			([n, vs]) =>
				`<saml:Attribute Name="${esc(n)}">${vs
					.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`)
					.join('')}</saml:Attribute>`
		)
		.join('');
	const asercion =
		`<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${idA}" Version="2.0" IssueInstant="${t(0)}">` +
		`<saml:Issuer>${esc(emisor)}</saml:Issuer>` +
		`<saml:Subject><saml:NameID Format="${esc(o.formatoNameId ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent')}">${esc(o.nameId ?? 'u-1')}</saml:NameID>` +
		`<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${t(5 * 60_000)}" Recipient="${esc(o.receptor ?? o.acs)}"/></saml:SubjectConfirmation></saml:Subject>` +
		`<saml:Conditions NotBefore="${t(-30_000)}" NotOnOrAfter="${t(5 * 60_000)}"><saml:AudienceRestriction><saml:Audience>${esc(o.audiencia)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
		`<saml:AuthnStatement AuthnInstant="${t(-1000)}" SessionIndex="${idA}"><saml:AuthnContext><saml:AuthnContextClassRef>${esc(o.contexto ?? 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport')}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
		(atributos ? `<saml:AttributeStatement>${atributos}</saml:AttributeStatement>` : '') +
		`</saml:Assertion>`;
	const firmar = (xml: string, id: string, despuesDe: string) => {
		const sig = new SignedXml({
			privateKey: o.claves.clave,
			publicCert: o.claves.cert,
			signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
			canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'
		});
		sig.addReference({
			xpath: `//*[@ID='${id}']`,
			transforms: [
				'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
				'http://www.w3.org/2001/10/xml-exc-c14n#'
			],
			digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256'
		});
		sig.computeSignature(xml, {
			location: { reference: `//*[@ID='${id}']/*[local-name()='${despuesDe}']`, action: 'after' }
		});
		return sig.getSignedXml();
	};
	let a = o.firmarAsercion === false ? asercion : firmar(asercion, idA, 'Issuer');
	if (o.cifrarPara) {
		const cert = o.cifrarPara;
		const datos = await new Promise<string>((bien, mal) =>
			encrypt(
				a,
				{
					rsa_pub: cert,
					pem: cert,
					encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
					keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
					disallowEncryptionWithInsecureAlgorithm: true,
					warnInsecureAlgorithm: false
				},
				(e, r) => (e ? mal(e) : bien(r))
			)
		);
		a = `<saml:EncryptedAssertion>${datos}</saml:EncryptedAssertion>`;
	}
	const destino = o.destino === '' ? '' : ` Destination="${esc(o.destino ?? o.acs)}"`;
	let r =
		`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${idR}" Version="2.0" IssueInstant="${t(0)}"${destino}${irt}>` +
		`<saml:Issuer>${esc(emisor)}</saml:Issuer>` +
		`<samlp:Status><samlp:StatusCode Value="${esc(estado)}"/></samlp:Status>` +
		(estado.endsWith(':Success') ? a.replace(/^<\?xml[^>]*>/, '') : '') +
		`</samlp:Response>`;
	if (o.firmarRespuesta !== false) r = firmar(r, idR, 'Issuer');
	return Buffer.from(r, 'utf8').toString('base64');
}
