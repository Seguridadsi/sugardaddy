/*
 * SAML 2.0 como proveedor de servicio (SP), sin base de datos: lo que usa
 * saml-propio.ts y se prueba suelto con un proveedor falso (saml-idp-falso.ts).
 * La validación la hace @node-saml/node-saml (MIT); aquí se le dan las opciones
 * estrictas y se añade lo que esa versión solo avisa:
 *
 * - firmadas la respuesta Y la aserción (wantAuthnResponseSigned y
 *   wantAssertionsSigned), con el certificado del proveedor, sin aceptar otro;
 * - emisor (idpIssuer), audiencia (la entidad del SP), y aquí además el
 *   `Recipient` de la confirmación bearer y el `Destination` de la respuesta,
 *   que tienen que ser el ACS de esta consola;
 * - `InResponseTo` siempre (nada iniciado por el proveedor: sin una ida desde
 *   esta consola no se entra) y cada aserción vale una sola vez
 *   (rejectReplayedAssertions), con la caché acotada de abajo;
 * - reloj: dos minutos de margen y una aserción no vale más de cinco minutos
 *   desde que se emitió, diga lo que diga su NotOnOrAfter;
 * - cifrado: si el proveedor cifra la aserción con el certificado del SP, se
 *   descifra; se puede exigir.
 *
 * La MFA se lee del `AuthnContextClassRef` (y del atributo
 * authnmethodsreferences que mandan ADFS y Entra), como en OIDC el `amr`/`acr`.
 */
import 'reflect-metadata';
import { X509Certificate, createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { DOMParser } from '@xmldom/xmldom';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export const NS_MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const NS_SAML = 'urn:oasis:names:tc:SAML:2.0:assertion';
const NS_SAMLP = 'urn:oasis:names:tc:SAML:2.0:protocol';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
export const NAMEID_TRANSITORIO = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const NAMEID_SIN_FORMATO = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';

/* Margen de reloj con el proveedor y vida máxima de una aserción. */
export const MARGEN_RELOJ_MS = 2 * 60_000;
export const VIDA_ASERCION_MS = 5 * 60_000;
/* Lo que puede tardar la persona en volver del proveedor. */
export const VIDA_IDA_MS = 10 * 60_000;

/*
 * Lo que dice MFA en el contexto de autenticación, de serie. ADFS y Entra:
 * multipleauthn; REFEDS (Shibboleth, InCommon, Keycloak con LoA): su perfil MFA.
 * Okta, Ping o Keycloak sin LoA mandan otros: se añaden en Ajustes.
 */
export const CONTEXTOS_MFA = [
	'http://schemas.microsoft.com/claims/multipleauthn',
	'https://refeds.org/profile/mfa',
	'http://schemas.microsoft.com/ws/2012/12/authmethod/phoneappnotification',
	'http://schemas.microsoft.com/ws/2012/12/authmethod/phoneappotp',
	'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken',
	'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract',
	'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered'
];
const ATRIBUTO_AMR = 'http://schemas.microsoft.com/claims/authnmethodsreferences';

/* Nombres de atributo que suelen llevar el correo y el nombre (el primero que venga). */
export const ATRIBUTOS_CORREO = [
	'email',
	'mail',
	'emailaddress',
	'urn:oid:0.9.2342.19200300.100.1.3',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
];
export const ATRIBUTOS_NOMBRE = [
	'displayName',
	'name',
	'urn:oid:2.16.840.1.113730.3.1.241',
	'http://schemas.microsoft.com/identity/claims/displayname',
	'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
];

export type Idp = { entidad: string; sso: string; certs: string[] };

export type ConfigSaml = Idp & {
	spEntidad: string;
	acs: string;
	/* Clave y certificado del SP, en PEM: firman las idas y descifran aserciones. */
	claveSp: string;
	certSp: string;
	contextos: string[];
	pedirContexto: boolean;
	exigirCifrado: boolean;
};

/* Lo que se saca de una aserción ya validada. */
export type Afirmacion = {
	nameId: string;
	formato: string | null;
	idAsercion: string;
	contextos: string[];
	atributos: Record<string, string[]>;
};

/* Solo el cuerpo base64 de un certificado (sin cabeceras ni espacios). */
export const cuerpoCert = (pem: string) =>
	pem
		.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
		.replace(/\s+/g, '')
		.trim();

export const pemCert = (cuerpo: string) =>
	`-----BEGIN CERTIFICATE-----\n${cuerpoCert(cuerpo)
		.replace(/(.{64})/g, '$1\n')
		.trim()}\n-----END CERTIFICATE-----\n`;

/* Huella SHA-256 y caducidad de un certificado (para enseñarlo); null si no es uno. */
export function datosCert(
	cuerpo: string
): { huella: string; caduca: string; sujeto: string } | null {
	try {
		const c = new X509Certificate(pemCert(cuerpo));
		return {
			huella: c.fingerprint256,
			caduca: new Date(c.validTo).toISOString(),
			sujeto: c.subject.replace(/\n/g, ', ').slice(0, 200)
		};
	} catch {
		return null;
	}
}

/* https://, sin usuario ni contraseña; http solo a localhost (pruebas). */
export function urlSegura(u: string): boolean {
	try {
		const x = new URL(u);
		if (x.username || x.password) return false;
		if (x.protocol === 'https:') return true;
		return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
	} catch {
		return false;
	}
}

/* XML a DOM; lanza si no está bien formado (xmldom, de serie, solo lo escribe en la consola). */
function analizar(xml: string): Document {
	const errores: string[] = [];
	const apuntar = (m: string) => errores.push(m);
	const doc = new DOMParser({
		errorHandler: { warning: () => {}, error: apuntar, fatalError: apuntar }
	}).parseFromString(xml, 'text/xml') as unknown as Document;
	if (errores.length || !doc?.documentElement) throw new Error(errores[0] ?? 'empty document');
	return doc;
}

/*
 * Lee los metadatos del proveedor (lo que publica ADFS en
 * /FederationMetadata/2007-06/FederationMetadata.xml, Okta, Keycloak en
 * …/protocol/saml/descriptor, Entra en «Federation Metadata XML»): su entidad,
 * el punto de entrada por HTTP-Redirect y los certificados de firma. Sin DTD ni
 * entidades externas: xmldom no las resuelve.
 */
export function leerMetadatosIdp(xml: string): Idp | { error: string } {
	if (xml.length > 500_000) return { error: 'The metadata file is too large.' };
	if (/<!DOCTYPE/i.test(xml)) return { error: 'The metadata must not contain a DOCTYPE.' };
	let doc: Document;
	try {
		doc = analizar(xml);
	} catch {
		return { error: 'That is not valid XML.' };
	}
	const raiz = doc.documentElement;
	let ed: Element | null = null;
	if (raiz.namespaceURI === NS_MD && raiz.localName === 'EntityDescriptor') ed = raiz;
	else {
		const eds = raiz.getElementsByTagNameNS(NS_MD, 'EntityDescriptor');
		for (let i = 0; i < eds.length && !ed; i++)
			if (eds[i].getElementsByTagNameNS(NS_MD, 'IDPSSODescriptor').length) ed = eds[i];
	}
	const idp = ed?.getElementsByTagNameNS(NS_MD, 'IDPSSODescriptor')[0];
	if (!ed || !idp)
		return { error: 'These are not identity provider metadata (no IDPSSODescriptor).' };
	const entidad = ed.getAttribute('entityID')?.trim() ?? '';
	if (!entidad) return { error: 'The metadata has no entityID.' };
	let sso = '';
	const servicios = idp.getElementsByTagNameNS(NS_MD, 'SingleSignOnService');
	for (let i = 0; i < servicios.length; i++)
		if (servicios[i].getAttribute('Binding') === REDIRECT)
			sso = servicios[i].getAttribute('Location')?.trim() ?? '';
	if (!sso)
		return {
			error: 'The metadata has no single sign-on address with the HTTP-Redirect binding.'
		};
	const certs: string[] = [];
	const llaves = idp.getElementsByTagNameNS(NS_MD, 'KeyDescriptor');
	for (let i = 0; i < llaves.length; i++) {
		const uso = llaves[i].getAttribute('use');
		if (uso && uso !== 'signing') continue;
		const xs = llaves[i].getElementsByTagNameNS(NS_DS, 'X509Certificate');
		for (let j = 0; j < xs.length; j++) {
			const c = cuerpoCert(xs[j].textContent ?? '');
			if (c && !certs.includes(c)) certs.push(c);
		}
	}
	if (!certs.length) return { error: 'The metadata has no signing certificate.' };
	return { entidad, sso, certs };
}

/* Comprueba lo que se va a guardar, venga de los metadatos o a mano. */
export function comprobarIdp(i: Idp): string | null {
	if (!i.entidad || i.entidad.length > 1024) return 'The identity provider entity ID is missing.';
	if (!urlSegura(i.sso)) return 'The single sign-on address is an https:// address.';
	if (!i.certs.length) return 'The signing certificate is missing.';
	if (i.certs.length > 5) return 'At most five signing certificates.';
	for (const c of i.certs) if (!datosCert(c)) return 'A signing certificate cannot be read.';
	return null;
}

/* Un par de claves RSA y certificado autofirmado del SP, para diez años. */
export async function generarClavesSp(nombre: string): Promise<{ clave: string; cert: string }> {
	const alg = {
		name: 'RSASSA-PKCS1-v1_5',
		hash: 'SHA-256',
		publicExponent: new Uint8Array([1, 0, 1]),
		modulusLength: 3072
	};
	const claves = (await webcrypto.subtle.generateKey(alg, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const ahora = Date.now();
	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: randomBytes(16)
			.toString('hex')
			.replace(/^[89a-f]/, '1'),
		name: `CN=${nombre.replace(/[,=+<>#;"\\]/g, ' ').slice(0, 60)}, O=Sugardaddy`,
		notBefore: new Date(ahora - 5 * 60_000),
		notAfter: new Date(ahora + 10 * 365 * 86_400_000),
		signingAlgorithm: alg,
		keys: claves
	});
	const pk = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', claves.privateKey));
	const clave = createPrivateKey({ key: pk, format: 'der', type: 'pkcs8' })
		.export({ type: 'pkcs8', format: 'pem' })
		.toString();
	return { clave, cert: cert.toString('pem') };
}

/*
 * Caché en memoria para node-saml: las idas pendientes (InResponseTo, se gastan
 * con consumeAsync) y las aserciones ya vistas (saveIfAbsentAsync). Acotada: sin
 * sesión cualquiera puede pedir idas, y no puede llenar la memoria. Llena, la
 * ida se niega (y se dice). Si la consola se reinicia se pierde: las idas a
 * medias fallan (se vuelve a entrar) y una respuesta vieja tampoco vale, porque
 * su InResponseTo ya no está.
 */
export class CacheAcotada implements CacheProvider {
	private m = new Map<string, { valor: string; creado: number; caduca: number }>();
	constructor(
		private vida = VIDA_IDA_MS,
		private maximo = 5000,
		private ahora = () => Date.now()
	) {}

	private podar() {
		const t = this.ahora();
		for (const [k, v] of this.m) if (v.caduca <= t) this.m.delete(k);
	}

	private sitio() {
		if (this.m.size >= this.maximo) this.podar();
		if (this.m.size >= this.maximo) throw new Error('too many pending sign-ins');
	}

	private vivo(k: string) {
		const v = this.m.get(k);
		if (v && v.caduca <= this.ahora()) {
			this.m.delete(k);
			return undefined;
		}
		return v;
	}

	async saveAsync(key: string, value: string) {
		if (this.vivo(key)) return null;
		this.sitio();
		const creado = this.ahora();
		this.m.set(key, { valor: value, creado, caduca: creado + this.vida });
		return { value, createdAt: creado };
	}

	async getAsync(key: string) {
		return this.vivo(key)?.valor ?? null;
	}

	async removeAsync(key: string | null) {
		if (key == null) return null;
		const v = this.vivo(key);
		this.m.delete(key);
		return v?.valor ?? null;
	}

	async consumeAsync(key: string) {
		return this.removeAsync(key);
	}

	async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number) {
		if (this.vivo(key)) return false;
		this.sitio();
		this.m.set(key, { valor: value, creado: this.ahora(), caduca: expiresAtMs });
		return true;
	}

	get tamano() {
		return this.m.size;
	}
}

export function crearSaml(c: ConfigSaml, cache: CacheProvider): SAML {
	return new SAML({
		entryPoint: c.sso,
		issuer: c.spEntidad,
		audience: c.spEntidad,
		callbackUrl: c.acs,
		idpIssuer: c.entidad,
		idpCert: c.certs.map(pemCert),
		/* Firma de las idas (AuthnRequest) con la clave del SP. */
		privateKey: c.claveSp,
		publicCert: c.certSp,
		signatureAlgorithm: 'sha256',
		digestAlgorithm: 'sha256',
		decryptionPvk: c.claveSp,
		wantAuthnResponseSigned: true,
		wantAssertionsSigned: true,
		validateInResponseTo: ValidateInResponseTo.always,
		rejectReplayedAssertions: true,
		requestIdExpirationPeriodMs: VIDA_IDA_MS,
		acceptedClockSkewMs: MARGEN_RELOJ_MS,
		maxAssertionAgeMs: VIDA_ASERCION_MS,
		cacheProvider: cache,
		/* Que el proveedor elija el formato; uno transitorio se rechaza luego. */
		identifierFormat: NAMEID_SIN_FORMATO,
		disableRequestedAuthnContext: !c.pedirContexto || !c.contextos.length,
		authnContext: c.contextos,
		racComparison: 'exact',
		forceAuthn: false
	});
}

/* La URL de ida al proveedor (HTTP-Redirect, firmada). */
export async function urlDeIda(saml: SAML, relay: string): Promise<string> {
	return saml.getAuthorizeUrlAsync(relay, undefined, {});
}

/* Los metadatos del SP, para cargarlos en el proveedor. */
export function metadatosSp(
	c: Pick<ConfigSaml, 'spEntidad' | 'acs' | 'certSp' | 'claveSp'>
): string {
	const saml = new SAML({
		issuer: c.spEntidad,
		callbackUrl: c.acs,
		idpCert: 'x',
		privateKey: c.claveSp,
		decryptionPvk: c.claveSp,
		signatureAlgorithm: 'sha256',
		digestAlgorithm: 'sha256',
		/* Firmados con la misma clave: el proveedor puede comprobar que no se tocaron. */
		signMetadata: true,
		identifierFormat: NAMEID_SIN_FORMATO,
		wantAssertionsSigned: true,
		validateInResponseTo: ValidateInResponseTo.always,
		rejectReplayedAssertions: true
	});
	/* Mismo certificado para firmar las idas y para que el proveedor cifre. */
	return saml.generateServiceProviderMetadata(c.certSp, c.certSp);
}

type Nodo = { _?: string; $?: Record<string, string> } & Record<string, unknown>;
const hijos = (n: unknown, k: string): Nodo[] => {
	const v = (n as Record<string, unknown> | undefined)?.[k];
	return Array.isArray(v) ? (v as Nodo[]) : [];
};
const texto = (n: Nodo | string | undefined) => (typeof n === 'string' ? n : (n?._ ?? '')).trim();

export class ErrorSaml extends Error {
	constructor(
		public motivo: 'firma' | 'destino' | 'receptor' | 'cifrado' | 'estado' | 'formato',
		mensaje: string
	) {
		super(mensaje);
	}
}

/* Raíz de la respuesta tal y como llegó (Destination, si viene cifrada). */
function raizRespuesta(base64: string): Element {
	if (base64.length > 1_000_000) throw new ErrorSaml('formato', 'SAML response too large');
	const xml = Buffer.from(base64, 'base64').toString('utf8');
	if (/<!DOCTYPE/i.test(xml)) throw new ErrorSaml('formato', 'DOCTYPE in SAML response');
	let r: Element | undefined;
	try {
		r = analizar(xml).documentElement;
	} catch {
		throw new ErrorSaml('formato', 'the SAML response is not valid XML');
	}
	if (!r || r.namespaceURI !== NS_SAMLP || r.localName !== 'Response')
		throw new ErrorSaml('formato', 'not a SAML Response');
	return r;
}

/*
 * Valida una respuesta que llega al ACS (HTTP-POST). Lanza ErrorSaml (o el error
 * de node-saml) si algo no cuadra; devuelve lo que dice la aserción verificada.
 */
export async function validarRespuesta(
	saml: SAML,
	c: Pick<ConfigSaml, 'acs' | 'exigirCifrado'>,
	SAMLResponse: string,
	RelayState: string
): Promise<Afirmacion> {
	const raiz = raizRespuesta(SAMLResponse);
	const cifrada = Array.from(raiz.childNodes).some(
		(n) =>
			(n as Element).namespaceURI === NS_SAML && (n as Element).localName === 'EncryptedAssertion'
	);
	if (c.exigirCifrado && !cifrada) throw new ErrorSaml('cifrado', 'the assertion is not encrypted');

	let profile: Profile | null;
	try {
		({ profile } = await saml.validatePostResponseAsync({ SAMLResponse, RelayState }));
	} catch (e) {
		const m = (e as Error).message ?? '';
		/* Cifrada con un algoritmo que no se sabe descifrar (rsa-oaep de xmlenc 1.1, p. ej.). */
		if (/encryption algorithm .* not supported|decrypt|oaep/i.test(m))
			throw new ErrorSaml('cifrado', m);
		if (/status|Responder|Requester|AuthnFailed|NoPassive/i.test(m) && !/signature/i.test(m))
			throw new ErrorSaml('estado', m);
		throw new ErrorSaml('firma', m);
	}
	if (!profile) throw new ErrorSaml('formato', 'no profile in the SAML response');

	/*
	 * Destination: la respuesta va firmada entera (wantAuthnResponseSigned), así
	 * que su raíz es la verificada. Si viene, tiene que ser este ACS.
	 */
	const destino = raiz.getAttribute('Destination');
	if (destino && destino !== c.acs)
		throw new ErrorSaml('destino', `Destination ${destino.slice(0, 200)} is not ${c.acs}`);

	const doc = profile.getAssertion?.() as { Assertion?: Nodo } | undefined;
	const a = doc?.Assertion;
	if (!a) throw new ErrorSaml('formato', 'no assertion');
	/* Recipient de la confirmación bearer: este ACS (node-saml 5 solo lo avisa). */
	const receptores = hijos(a, 'Subject')
		.flatMap((s) => hijos(s, 'SubjectConfirmation'))
		.filter((sc) => sc.$?.Method === 'urn:oasis:names:tc:SAML:2.0:cm:bearer')
		.flatMap((sc) => hijos(sc, 'SubjectConfirmationData'))
		.map((d) => d.$?.Recipient);
	if (!receptores.includes(c.acs))
		throw new ErrorSaml('receptor', 'no bearer SubjectConfirmation for this console');

	const contextos = hijos(a, 'AuthnStatement')
		.flatMap((s) => hijos(s, 'AuthnContext'))
		.flatMap((x) => hijos(x, 'AuthnContextClassRef'))
		.map(texto)
		.filter(Boolean);
	const atributos: Record<string, string[]> = {};
	for (const [k, v] of Object.entries((profile.attributes as Record<string, unknown>) ?? {})) {
		const vs = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
		atributos[k] = vs.map((x) => x.trim()).filter(Boolean);
	}
	return {
		nameId: profile.nameID ?? '',
		formato: profile.nameIDFormat ?? null,
		idAsercion: a.$?.ID ?? '',
		contextos,
		atributos
	};
}

/* ¿Hubo MFA? Un contexto de la lista (de serie más los de Ajustes) o el atributo amr con multipleauthn. */
export function huboMfaSaml(a: Pick<Afirmacion, 'contextos' | 'atributos'>, extra: string[] = []) {
	const vale = new Set([...CONTEXTOS_MFA, ...extra]);
	if (a.contextos.some((c) => vale.has(c))) return true;
	return (a.atributos[ATRIBUTO_AMR] ?? []).some(
		(v) => v === 'http://schemas.microsoft.com/claims/multipleauthn' || vale.has(v)
	);
}

/* El primer valor de la lista de atributos que tenga algo. */
export function primerAtributo(a: Afirmacion, nombres: string[]): string | null {
	for (const n of nombres) {
		const v = a.atributos[n]?.[0];
		if (v) return v;
	}
	return null;
}

/* El correo: el atributo configurado, los habituales o el NameID si tiene forma de correo. */
export function correoSaml(a: Afirmacion, atributo: string): string | null {
	const v = primerAtributo(a, [...(atributo ? [atributo] : []), ...ATRIBUTOS_CORREO]);
	const correo = (v ?? (a.nameId.includes('@') ? a.nameId : '')).trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+$/.test(correo) && correo.length <= 254 ? correo : null;
}
