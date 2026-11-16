/*
 * mTLS entre los sensores remotos y la consola (docs/diseno/mtls-sensores.md).
 *
 * La CA propia del nodo (ca-nodo.ts) no sirve para esto: solo firma para
 * serverAuth y para la dirección de la consola, y la clave de su raíz no se
 * guarda. Los sensores tienen su propia CA, la «CA de sensores»: la crea la
 * consola la primera vez, guarda su clave cifrada con CLAVE_SECRETOS y firma
 * con ella un certificado de cliente para cada sensor remoto (clientAuth, 90
 * días). Caddy, que termina el TLS, pide certificado de cliente con esa raíz
 * (verify_if_given: el navegador no lo tiene y entra igual) y le pasa a la
 * consola la huella del que presentó. La consola es la que decide: el
 * certificado tiene que ser el de ese sensor (además de su token), no estar
 * revocado ni caducado. Así revocar es cambiar una fila, sin CRL.
 *
 * Compatibilidad: un sensor instalado antes no tiene certificado. Mientras la
 * política es «grace» entra solo con su token y se avisa; en cuanto llega una
 * vez con su certificado, ya no entra sin él. Con «require», ninguno entra
 * sin certificado.
 */
/* @peculiar/x509 usa tsyringe, que necesita el polyfill de Reflect antes de cargarse. */
import 'reflect-metadata';
import { X509Certificate, createHash, randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { error } from '@sveltejs/kit';
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema as s } from './db';
import { cifrar, descifrar, estadoClave } from './secretos';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const CLAVE_CA = 'ca-sensores';
const CLAVE_POLITICA = 'mtls-sensores';
const CONTEXTO = 'ca-sensores';
const DIA = 24 * 60 * 60_000;
/* Vida de un certificado de sensor y cuándo se renueva (lo pide su actualizador). */
export const VIDA_CERTIFICADO = 90 * DIA;
export const RENOVAR_ANTES = 30 * DIA;
/* Las cabeceras que pone Caddy (Caddyfile, cabeceras-sensor): las de fuera las quita siempre. */
export const CABECERA_MTLS = 'x-sugardaddy-mtls';
export const CABECERA_HUELLA = 'x-sugardaddy-certificado';

const ALG: EcKeyGenParams & EcdsaParams = {
	name: 'ECDSA',
	namedCurve: 'P-256',
	hash: 'SHA-256'
};

type AjusteCa = { raiz: string; clave: string; creada: string };
export type Politica = 'grace' | 'require';

const pemClave = (der: ArrayBuffer) =>
	`-----BEGIN PRIVATE KEY-----\n${Buffer.from(der)
		.toString('base64')
		.replace(/.{1,64}/g, '$&\n')}-----END PRIVATE KEY-----\n`;

/* La huella como la da Caddy ({http.request.tls.client.fingerprint}): sha256 del DER, hex en minúsculas. */
export function huellaCertificado(pem: string): string {
	return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}

/*
 * Sin certificado, Caddy pone en la cabecera el sha256 de nada (comprobado con
 * la 2.11.7): eso es «no presentó ninguno».
 */
const SHA256_VACIO = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function limpiarHuella(h: string | null | undefined): string {
	const l = (h ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
	return l.length === 64 && l !== SHA256_VACIO ? l : '';
}

async function leerAjuste<T>(clave: string): Promise<T | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return (f?.valor as T | undefined) ?? null;
}

/* La raíz pública de la CA de sensores, o null si aún no hay (o el nodo no tiene CLAVE_SECRETOS). */
export async function raizSensores(): Promise<string | null> {
	return (await leerAjuste<AjusteCa>(CLAVE_CA))?.raiz ?? null;
}

async function generarCa(nodo: string): Promise<AjusteCa> {
	const claves = (await webcrypto.subtle.generateKey(ALG, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const ahora = new Date();
	const raiz = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: randomBytes(16)
			.toString('hex')
			.replace(/^[89a-f]/, '1'),
		name: `CN=Sugardaddy remote sensors CA, O=Sugardaddy, OU=${nodo.replace(/[,=+<>#;"\\]/g, ' ')}`,
		notBefore: new Date(ahora.getTime() - 5 * 60_000),
		notAfter: new Date(ahora.getTime() + 10 * 365 * DIA),
		signingAlgorithm: ALG,
		keys: claves,
		extensions: [
			new x509.BasicConstraintsExtension(true, 0, true),
			new x509.KeyUsagesExtension(
				x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
				true
			),
			/* Solo para certificados de cliente: no vale para firmar un HTTPS ni código. */
			new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
			await x509.SubjectKeyIdentifierExtension.create(claves.publicKey)
		]
	});
	const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', claves.privateKey);
	return {
		raiz: raiz.toString('pem') + '\n',
		clave: cifrar({ pkcs8: Buffer.from(pkcs8).toString('base64') }, CONTEXTO),
		creada: ahora.toISOString()
	};
}

/*
 * La CA de sensores, creándola si no la hay. null sin CLAVE_SECRETOS: sin ella
 * la clave no se puede guardar y los sensores siguen solo con su token.
 */
export async function asegurarCaSensores(): Promise<AjusteCa | null> {
	const hay = await leerAjuste<AjusteCa>(CLAVE_CA);
	if (hay) return hay;
	if (estadoClave() !== 'lista') return null;
	const nueva = await generarCa(process.env.NODO_ID ?? 'node');
	/* Dos peticiones a la vez: gana la primera, y las dos usan la misma. */
	await db
		.insert(s.ajustes)
		.values({ clave: CLAVE_CA, valor: nueva })
		.onConflictDoNothing({ target: s.ajustes.clave });
	const ca = await leerAjuste<AjusteCa>(CLAVE_CA);
	if (ca?.raiz === nueva.raiz)
		await db.insert(s.auditoria).values({
			quien: 'machine',
			accion: 'remote sensor CA created',
			detalle: { huella: huellaCertificado(nueva.raiz) }
		});
	return ca;
}

async function firmante(ca: AjusteCa) {
	const d = descifrar(ca.clave, CONTEXTO);
	if (!d.ok)
		throw new Error(
			`The remote sensor CA key cannot be read (${d.motivo}): CLAVE_SECRETOS changed or is missing`
		);
	const clave = await webcrypto.subtle.importKey(
		'pkcs8',
		Buffer.from(d.valores.pkcs8, 'base64'),
		ALG,
		false,
		['sign']
	);
	return { clave, raiz: new x509.X509Certificate(ca.raiz) };
}

/*
 * Firma un certificado de cliente para el sensor con esa clave pública. El
 * anterior actual pasa a «anterior» (vale hasta que el sensor llega con el
 * nuevo) y los anteriores de antes se revocan.
 */
async function firmar(
	sensor: string,
	publica: CryptoKey | x509.PublicKey,
	motivo: string
): Promise<string> {
	const ca = await asegurarCaSensores();
	if (!ca) throw new Error('This node has no key for encrypting secrets (CLAVE_SECRETOS)');
	const { clave, raiz } = await firmante(ca);
	const ahora = new Date();
	const hasta = new Date(ahora.getTime() + VIDA_CERTIFICADO);
	const serie = randomBytes(16)
		.toString('hex')
		.replace(/^[89a-f]/, '1');
	const cert = await x509.X509CertificateGenerator.create({
		serialNumber: serie,
		subject: `CN=${sensor}, O=Sugardaddy remote sensor`,
		issuer: raiz.subject,
		notBefore: new Date(ahora.getTime() - 5 * 60_000),
		notAfter: hasta,
		signingAlgorithm: ALG,
		publicKey: publica,
		signingKey: clave,
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
			new x509.SubjectAlternativeNameExtension([
				{ type: 'url', value: `urn:sugardaddy:sensor:${sensor}` }
			]),
			await x509.AuthorityKeyIdentifierExtension.create(raiz)
		]
	});
	const pem = cert.toString('pem') + '\n';
	const huella = huellaCertificado(pem);
	await db.transaction(async (tx) => {
		await tx
			.update(s.certificadosSensor)
			.set({ estado: 'revocado', revocado: ahora })
			.where(
				and(eq(s.certificadosSensor.sensor, sensor), eq(s.certificadosSensor.estado, 'anterior'))
			);
		await tx
			.update(s.certificadosSensor)
			.set({ estado: 'anterior' })
			.where(
				and(eq(s.certificadosSensor.sensor, sensor), eq(s.certificadosSensor.estado, 'actual'))
			);
		await tx.insert(s.certificadosSensor).values({
			huella,
			sensor,
			serie,
			estado: 'actual',
			desde: ahora,
			hasta
		});
		await tx.insert(s.auditoria).values({
			quien: 'machine',
			accion: 'remote sensor certificate issued',
			detalle: { id: sensor, huella, serie, hasta: hasta.toISOString(), motivo }
		});
	});
	return pem;
}

/*
 * Para el instalador de un sensor remoto: la clave y el certificado en un solo
 * PEM (Go y curl lo leen así). La clave se crea aquí y va en el guion de un
 * solo uso, como el token; en la consola no queda. null sin CLAVE_SECRETOS.
 */
export async function certificadoParaInstalador(sensor: string): Promise<string | null> {
	if (!(await asegurarCaSensores())) return null;
	const claves = (await webcrypto.subtle.generateKey(ALG, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const cert = await firmar(sensor, claves.publicKey, 'install');
	return cert + pemClave(await webcrypto.subtle.exportKey('pkcs8', claves.privateKey));
}

export type ErrorCsr = { estado: number; mensaje: string };

/*
 * Renovación (o el primero de un sensor de antes): el actualizador del sensor
 * manda una CSR con su clave nueva. Solo se firma si toca: sin certificado
 * actual, o con menos de RENOVAR_ANTES de vida. Si el actual ya se ha usado, la
 * petición tiene que llegar con él: un token robado no consigue certificado.
 */
export async function renovarConCsr(
	sensor: string,
	csrPem: unknown,
	presentada: string,
	ahora = new Date()
): Promise<{ certificado: string } | ErrorCsr> {
	if (typeof csrPem !== 'string' || csrPem.length > 8000)
		return { estado: 400, mensaje: 'Expected { csr: "<PEM>" }' };
	let csr: x509.Pkcs10CertificateRequest;
	try {
		csr = new x509.Pkcs10CertificateRequest(csrPem.trim());
		if (!(await csr.verify())) throw new Error('bad signature');
	} catch {
		return { estado: 400, mensaje: 'The certificate request is not valid' };
	}
	const alg = csr.publicKey.algorithm as EcKeyAlgorithm;
	if (alg.name !== 'ECDSA' || alg.namedCurve !== 'P-256')
		return { estado: 400, mensaje: 'The certificate request must use an ECDSA P-256 key' };
	const [actual] = await db
		.select()
		.from(s.certificadosSensor)
		.where(and(eq(s.certificadosSensor.sensor, sensor), eq(s.certificadosSensor.estado, 'actual')));
	if (actual?.visto && limpiarHuella(presentada) !== actual.huella)
		return {
			estado: 403,
			mensaje: 'Renewing needs the current client certificate of this sensor'
		};
	if (actual && actual.hasta.getTime() - ahora.getTime() > RENOVAR_ANTES)
		return { estado: 409, mensaje: 'The current certificate is not due for renewal yet' };
	if (!(await asegurarCaSensores()))
		return { estado: 503, mensaje: 'This console cannot issue client certificates yet' };
	return { certificado: await firmar(sensor, csr.publicKey, actual ? 'renewal' : 'first') };
}

let politicaCache: { valor: Politica; hasta: number } | null = null;

export async function leerPolitica(): Promise<Politica> {
	if (politicaCache && politicaCache.hasta > Date.now()) return politicaCache.valor;
	const p = await leerAjuste<{ politica?: string }>(CLAVE_POLITICA);
	const valor: Politica = p?.politica === 'require' ? 'require' : 'grace';
	politicaCache = { valor, hasta: Date.now() + 15_000 };
	return valor;
}

/*
 * Lo que mira sensorDe en cada petición de un sensor remoto, después del token.
 * Lanza 401 si no entra; si entra, apunta que usó su certificado.
 */
export async function comprobarCertificadoSensor(
	sensor: { id: string; remoto: boolean },
	request: Request
): Promise<void> {
	if (!sensor.remoto) return;
	const mtls = request.headers.get(CABECERA_MTLS) === '1';
	const huella = mtls ? limpiarHuella(request.headers.get(CABECERA_HUELLA)) : '';
	const ahora = new Date();
	if (huella) {
		const [c] = await db
			.select()
			.from(s.certificadosSensor)
			.where(
				and(
					eq(s.certificadosSensor.huella, huella),
					eq(s.certificadosSensor.sensor, sensor.id),
					inArray(s.certificadosSensor.estado, ['actual', 'anterior']),
					gt(s.certificadosSensor.hasta, ahora)
				)
			);
		if (!c) error(401, 'This client certificate is not valid for this sensor');
		if (c.estado === 'actual' && !c.visto)
			await db.transaction(async (tx) => {
				await tx
					.update(s.certificadosSensor)
					.set({ visto: ahora })
					.where(eq(s.certificadosSensor.huella, c.huella));
				/* Ya llega con el nuevo: el de antes deja de valer. */
				await tx
					.update(s.certificadosSensor)
					.set({ estado: 'revocado', revocado: ahora })
					.where(
						and(
							eq(s.certificadosSensor.sensor, sensor.id),
							eq(s.certificadosSensor.estado, 'anterior')
						)
					);
			});
		return;
	}
	if ((await leerPolitica()) === 'require')
		error(401, 'This console requires a client certificate from remote sensors');
	/* Caddy pide certificado y este sensor ya ha llegado con el suyo: sin él, no. */
	if (mtls) {
		const [usado] = await db
			.select({ huella: s.certificadosSensor.huella })
			.from(s.certificadosSensor)
			.where(
				and(
					eq(s.certificadosSensor.sensor, sensor.id),
					eq(s.certificadosSensor.estado, 'actual'),
					sql`${s.certificadosSensor.visto} is not null`
				)
			);
		if (usado) error(401, 'This sensor must present its client certificate');
	}
}

/* Al retirar un sensor: sus certificados dejan de valer. */
export async function revocarCertificados(
	bd: Pick<typeof db, 'update'>,
	sensor: string
): Promise<void> {
	await bd
		.update(s.certificadosSensor)
		.set({ estado: 'revocado', revocado: new Date() })
		.where(
			and(eq(s.certificadosSensor.sensor, sensor), ne(s.certificadosSensor.estado, 'revocado'))
		);
}

export type EstadoCertificado =
	'en-uso' | 'sin-usar' | 'sin-certificado' | 'caduca-pronto' | 'caducado';

export type FilaSensorMtls = {
	id: string;
	nombre: string;
	estado: EstadoCertificado;
	huella: string | null;
	hasta: string | null;
	visto: string | null;
};

/* Los sensores remotos en activo y su certificado, para Ajustes y el aviso de Sensores. */
export async function estadoSensoresMtls(ahora = new Date()): Promise<FilaSensorMtls[]> {
	const remotos = await db
		.select({ id: s.sensores.id, nombre: s.sensores.nombre })
		.from(s.sensores)
		.where(and(eq(s.sensores.remoto, true), isNull(s.sensores.retirado)));
	if (!remotos.length) return [];
	const certs = await db
		.select()
		.from(s.certificadosSensor)
		.where(
			and(
				inArray(
					s.certificadosSensor.sensor,
					remotos.map((r) => r.id)
				),
				eq(s.certificadosSensor.estado, 'actual')
			)
		);
	return remotos.map((r) => {
		const c = certs.find((x) => x.sensor === r.id);
		let estado: EstadoCertificado = 'sin-certificado';
		if (c) {
			const resta = c.hasta.getTime() - ahora.getTime();
			estado =
				resta <= 0
					? 'caducado'
					: !c.visto
						? 'sin-usar'
						: resta < RENOVAR_ANTES / 2
							? 'caduca-pronto'
							: 'en-uso';
		}
		return {
			id: r.id,
			nombre: r.nombre,
			estado,
			huella: c?.huella ?? null,
			hasta: c?.hasta.toISOString() ?? null,
			visto: c?.visto?.toISOString() ?? null
		};
	});
}

/*
 * Cambiar la política. Pasar a «require» con sensores que aún no han llegado
 * con su certificado los deja fuera: solo si quien lo hace lo confirma.
 */
export async function cambiarPolitica(
	quien: string,
	politica: Politica,
	cortar = false
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (politica === 'require') {
		if (!(await raizSensores()))
			return {
				ok: false,
				error:
					'This console has no remote sensor CA yet (it needs CLAVE_SECRETOS): sensors cannot present a certificate.'
			};
		const fuera = (await estadoSensoresMtls()).filter(
			(f) => f.estado !== 'en-uso' && f.estado !== 'caduca-pronto'
		);
		if (fuera.length && !cortar)
			return {
				ok: false,
				error: `These remote sensors have not connected with a client certificate yet and would lose contact with the console: ${fuera
					.map((f) => f.nombre)
					.join(', ')}. Update them, or confirm that they will need a new install line.`
			};
	}
	await db
		.insert(s.ajustes)
		.values({ clave: CLAVE_POLITICA, valor: { politica } })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: { politica } } });
	await db
		.insert(s.auditoria)
		.values({ quien, accion: 'remote sensor certificate policy changed', detalle: { politica } });
	politicaCache = null;
	return { ok: true };
}
