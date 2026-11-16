/*
 * mTLS de los sensores remotos (docs/diseno/mtls-sensores.md), en la base de
 * verdad: la CA de sensores, el certificado del instalador, lo que deja entrar
 * cada petición según las cabeceras de Caddy, la renovación con CSR, la
 * revocación al retirar y la política.
 */
import { X509Certificate, createPrivateKey, webcrypto } from 'node:crypto';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL || !process.env.CLAVE_SECRETOS)(
	'CA de sensores y mTLS',
	async () => {
		const { db, schema: s } = await import('./db');
		const { eq, like } = await import('drizzle-orm');
		const ca = await import('./ca-sensores');
		const { retirarSensor } = await import('./gestion');
		const PREFIJO = 'zz-mtls-';
		const id = (n: string) => PREFIJO + n;

		const limpiar = async () => {
			await db.delete(s.sensores).where(like(s.sensores.id, `${PREFIJO}%`));
			await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'mtls-sensores'));
			await ca.cambiarPolitica('zz-mtls@prueba', 'grace');
		};
		beforeAll(() => db.delete(s.ajustes).where(eq(s.ajustes.clave, 'ca-sensores')));
		beforeEach(limpiar);
		afterAll(limpiar);

		const alta = (n: string, remoto = true) =>
			db.insert(s.sensores).values({
				id: id(n),
				nombre: `Sede ${n}`,
				claveHash: `${PREFIJO}${n}-hash`,
				remoto
			});
		/* La petición tal como llega de Caddy: con mTLS, la huella del certificado (o el sha256 de nada). */
		const peticion = (huella: string | null, mtls = true) =>
			new Request('http://consola/api/sensor/estado', {
				headers: mtls
					? {
							'x-sugardaddy-mtls': '1',
							'x-sugardaddy-certificado':
								huella ?? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
						}
					: {}
			});
		const entra = async (n: string, r: Request, remoto = true) => {
			try {
				await ca.comprobarCertificadoSensor({ id: id(n), remoto }, r);
				return true;
			} catch (e) {
				if ((e as { status?: number }).status === 401) return false;
				throw e;
			}
		};
		const csr = async () => {
			const claves = (await webcrypto.subtle.generateKey(
				{ name: 'ECDSA', namedCurve: 'P-256' },
				true,
				['sign', 'verify']
			)) as CryptoKeyPair;
			const c = await x509.Pkcs10CertificateRequestGenerator.create({
				name: 'CN=lo-que-sea',
				keys: claves,
				signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }
			});
			return c.toString('pem');
		};
		const huellaDe = (pem: string) => ca.huellaCertificado(pem);

		it('crea una sola CA, solo para certificados de cliente, con la clave cifrada', async () => {
			const [a, b] = await Promise.all([ca.asegurarCaSensores(), ca.asegurarCaSensores()]);
			expect(a!.raiz).toBe(b!.raiz);
			const raiz = new X509Certificate(a!.raiz);
			expect(raiz.ca).toBe(true);
			expect(raiz.subject).toContain('Sugardaddy remote sensors CA');
			expect(a!.clave).not.toContain('PRIVATE');
			expect(await ca.raizSensores()).toBe(a!.raiz);
		});

		it('el instalador recibe certificado y clave, firmados por la CA, para clientAuth', async () => {
			await alta('a');
			const pem = (await ca.certificadoParaInstalador(id('a')))!;
			const cert = new X509Certificate(pem);
			const raiz = new X509Certificate((await ca.raizSensores())!);
			expect(cert.verify(raiz.publicKey)).toBe(true);
			expect(cert.subject).toContain(`CN=${id('a')}`);
			expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.2');
			expect(cert.checkPrivateKey(createPrivateKey(pem))).toBe(true);
			const [f] = await db
				.select()
				.from(s.certificadosSensor)
				.where(eq(s.certificadosSensor.sensor, id('a')));
			expect(f).toMatchObject({ estado: 'actual', huella: huellaDe(pem), visto: null });
			expect(f.hasta.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
		});

		it('en gracia: sin certificado entra hasta que llega una vez con el suyo', async () => {
			await alta('b');
			const pem = (await ca.certificadoParaInstalador(id('b')))!;
			expect(await entra('b', peticion(null))).toBe(true);
			expect(await entra('b', peticion(null, false))).toBe(true);
			expect(await entra('b', peticion(huellaDe(pem)))).toBe(true);
			/* Ya lo ha usado: sin él, no; salvo si Caddy no lo pide (una versión vuelta atrás). */
			expect(await entra('b', peticion(null))).toBe(false);
			expect(await entra('b', peticion(null, false))).toBe(true);
			const [f] = await db
				.select()
				.from(s.certificadosSensor)
				.where(eq(s.certificadosSensor.sensor, id('b')));
			expect(f.visto).not.toBeNull();
		});

		it('un certificado de otro sensor, inventado o fingido sin Caddy no vale', async () => {
			await alta('c');
			await alta('d');
			const deD = (await ca.certificadoParaInstalador(id('d')))!;
			await ca.certificadoParaInstalador(id('c'));
			expect(await entra('c', peticion(huellaDe(deD)))).toBe(false);
			expect(await entra('c', peticion('ab'.repeat(32)))).toBe(false);
			/* Sin la marca de Caddy, la huella no se mira: cuenta como sin certificado. */
			const fingida = new Request('http://consola/', {
				headers: { 'x-sugardaddy-certificado': huellaDe(deD) }
			});
			expect(await entra('d', fingida)).toBe(true);
			const [f] = await db
				.select()
				.from(s.certificadosSensor)
				.where(eq(s.certificadosSensor.sensor, id('d')));
			expect(f.visto).toBeNull();
		});

		it('los sensores del nodo no necesitan certificado', async () => {
			await alta('local', false);
			await ca.cambiarPolitica('zz-mtls@prueba', 'require', true);
			expect(await entra('local', peticion(null, false), false)).toBe(true);
		});

		it('renueva con CSR solo cuando toca, y con el certificado de ahora', async () => {
			await alta('e');
			/* Un sensor de antes, sin certificado: consigue el primero con su token. */
			const primero = await ca.renovarConCsr(id('e'), await csr(), '');
			expect('certificado' in primero).toBe(true);
			const h1 = huellaDe((primero as { certificado: string }).certificado);
			/* Aún no toca. */
			expect(await ca.renovarConCsr(id('e'), await csr(), h1)).toMatchObject({ estado: 409 });
			/* Ya lo ha usado: sin presentarlo no se renueva aunque toque. */
			await entra('e', peticion(h1));
			const dentro = new Date(Date.now() + 70 * 86_400_000);
			expect(await ca.renovarConCsr(id('e'), await csr(), '', dentro)).toMatchObject({
				estado: 403
			});
			const r = await ca.renovarConCsr(id('e'), await csr(), h1, dentro);
			const h2 = huellaDe((r as { certificado: string }).certificado);
			/* Mientras no llega con el nuevo, valen los dos; cuando llega, el viejo deja de valer. */
			expect(await entra('e', peticion(h1))).toBe(true);
			expect(await entra('e', peticion(h2))).toBe(true);
			expect(await entra('e', peticion(h1))).toBe(false);
			expect(await ca.renovarConCsr(id('e'), 'basura', h2)).toMatchObject({ estado: 400 });
		});

		it('al retirar un sensor su certificado deja de valer', async () => {
			await alta('f');
			const pem = (await ca.certificadoParaInstalador(id('f')))!;
			await entra('f', peticion(huellaDe(pem)));
			/* Sin eventos se borra, y su certificado con él; con eventos se revoca (gestion.ts). */
			await retirarSensor('zz-mtls@prueba', id('f'));
			expect(await entra('f', peticion(huellaDe(pem)))).toBe(false);
		});

		it('pasar a «require» con sensores sin certificado pide confirmarlo', async () => {
			await alta('g');
			await ca.certificadoParaInstalador(id('g'));
			const r = await ca.cambiarPolitica('zz-mtls@prueba', 'require');
			expect(r).toMatchObject({ ok: false });
			expect((r as { error: string }).error).toContain('Sede g');
			expect(await ca.cambiarPolitica('zz-mtls@prueba', 'require', true)).toEqual({ ok: true });
			expect(await ca.leerPolitica()).toBe('require');
			expect(await entra('g', peticion(null))).toBe(false);
			expect(await entra('g', peticion(null, false))).toBe(false);
		});

		it('el estado de cada sensor, para Ajustes', async () => {
			await alta('h');
			await alta('i');
			const pem = (await ca.certificadoParaInstalador(id('h')))!;
			await entra('h', peticion(huellaDe(pem)));
			const filas = (await ca.estadoSensoresMtls()).filter((f) => f.id.startsWith(PREFIJO));
			expect(Object.fromEntries(filas.map((f) => [f.id, f.estado]))).toEqual({
				[id('h')]: 'en-uso',
				[id('i')]: 'sin-certificado'
			});
		});
	}
);
