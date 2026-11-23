/*
 * SAML contra un Keycloak de verdad: lo levanta herramientas/probar-saml-keycloak.sh
 * en Docker y pasa su dirección en KEYCLOAK_URL (con DATABASE_URL); sin ellas, se
 * salta. Crea un reino con un cliente SAML hecho con los metadatos del SP que da
 * la consola (firmas, cifrado de la aserción y AuthnRequest firmada), un usuario
 * en el grupo de administradores, y recorre la entrada como un navegador: ida
 * desde la consola, el formulario de Keycloak, el POST al ACS y el fin.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const KC = process.env.KEYCLOAK_URL?.replace(/\/+$/, '');
const hay = !!process.env.DATABASE_URL && !!KC;
process.env.CLAVE_SECRETOS ||= 'ab'.repeat(32);

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hay ? await import('../db') : ({} as never);
const saml = hay ? await import('./saml-propio') : ({} as never);
const { metadatosSp } = await import('./saml');
const rutas = hay
	? {
			login: await import('../../../routes/auth/saml/login/+server'),
			acs: await import('../../../routes/auth/saml/acs/+server'),
			fin: await import('../../../routes/auth/saml/fin/+server')
		}
	: ({} as never);
const { eq, like } = await import('drizzle-orm');

const ORIGEN = 'https://consola.banco.example';
const REINO = 'banco';
const ADMIN = { correo: 'admin@banco.es', roles: ['admin'], oid: 'local:1', soporte: false };
let token = '';

async function kc(ruta: string, init: RequestInit = {}) {
	const r = await fetch(`${KC}/admin/realms${ruta}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			...(init.headers ?? {})
		}
	});
	if (!r.ok && r.status !== 404) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
	return r;
}

function tarro() {
	const m = new Map<string, string>();
	return {
		m,
		get: (k: string) => m.get(k),
		getAll: () => [...m].map(([name, value]) => ({ name, value })),
		set: (k: string, v: string) => void m.set(k, v),
		delete: (k: string) => void m.delete(k),
		serialize: () => ''
	};
}

async function destino(f: () => Promise<unknown>): Promise<string> {
	try {
		await f();
	} catch (e) {
		const r = e as { status?: number; location?: string };
		if (r.status && r.location) return r.location;
		throw e;
	}
	throw new Error('no redirect');
}

const html = (t: string) =>
	t
		.replace(/&amp;/g, '&')
		.replace(/&#x3d;/gi, '=')
		.replace(/&quot;/g, '"');

/*
 * El navegador frente a Keycloak: sigue redirecciones con sus cookies, rellena
 * el formulario de entrada y devuelve el formulario que manda al ACS.
 */
async function entrarEnKeycloak(url: string, usuario: string, clave: string) {
	const galletas = new Map<string, string>();
	const pedir = async (u: string, init: RequestInit = {}) => {
		let r: Response;
		for (let i = 0; i < 10; i++) {
			r = await fetch(u, {
				...init,
				redirect: 'manual',
				headers: {
					...(init.headers ?? {}),
					cookie: [...galletas].map(([k, v]) => `${k}=${v}`).join('; ')
				}
			});
			for (const c of r.headers.getSetCookie()) {
				const [kv] = c.split(';');
				const n = kv.indexOf('=');
				galletas.set(kv.slice(0, n), kv.slice(n + 1));
			}
			const loc = r.headers.get('location');
			if (!loc || r.status < 300 || r.status >= 400) return r;
			u = new URL(loc, u).toString();
			init = {};
		}
		throw new Error('too many redirects');
	};
	let r = await pedir(url);
	let t = await r.text();
	const accion = t.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1];
	if (!accion) throw new Error(`no Keycloak login form: ${r.status} ${t.slice(0, 300)}`);
	r = await pedir(html(accion), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ username: usuario, password: clave })
	});
	t = await r.text();
	const campo = (n: string) =>
		t.match(new RegExp(`name="${n}"\\s+value="([^"]*)"`))?.[1] ??
		t.match(new RegExp(`value="([^"]*)"\\s+name="${n}"`))?.[1];
	const SAMLResponse = campo('SAMLResponse');
	if (!SAMLResponse)
		throw new Error(
			`no SAMLResponse: ${r.status} ${t
				.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.slice(0, 600)}`
		);
	return {
		accion: html(t.match(/<form[^>]*action="([^"]+)"/)![1]),
		SAMLResponse: html(SAMLResponse),
		RelayState: html(campo('RelayState') ?? '')
	};
}

async function entrar(locals: object, consulta: string) {
	const k = tarro();
	const ida = await destino(
		() =>
			rutas.login.GET({
				url: new URL(`${ORIGEN}/auth/saml/login${consulta}`),
				cookies: k,
				locals
			} as never) as Promise<unknown>
	);
	const f = await entrarEnKeycloak(ida, 'ana', 'Clave-de-prueba-1');
	expect(f.accion).toBe(`${ORIGEN}/auth/saml/acs`);
	const a = await destino(
		() =>
			rutas.acs.POST({
				request: new Request(f.accion, {
					method: 'POST',
					body: new URLSearchParams({ SAMLResponse: f.SAMLResponse, RelayState: f.RelayState }),
					headers: { 'content-type': 'application/x-www-form-urlencoded' }
				})
			} as never) as Promise<unknown>
	);
	if (!a.startsWith('/auth/saml/fin')) return { a, respuesta: f.SAMLResponse };
	return {
		a: await destino(
			() =>
				rutas.fin.GET({ url: new URL(a, ORIGEN), cookies: k, locals } as never) as Promise<unknown>
		),
		respuesta: f.SAMLResponse
	};
}

const datos = (metadatos: string, exigirMfa: boolean) => ({
	metadatos,
	entidad: '',
	sso: '',
	cert: '',
	nombre: 'Keycloak',
	atributoRoles: 'groups',
	atributoCorreo: 'email',
	roles: { admin: 'sd-admins' } as Record<string, string>,
	exigirMfa,
	contextos: '',
	pedirContexto: false,
	exigirCifrado: true
});

describe.skipIf(!hay)('SAML contra Keycloak', () => {
	let descriptor = '';
	beforeAll(async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, saml.AJUSTE_SAML));
		const t = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
			method: 'POST',
			body: new URLSearchParams({
				grant_type: 'password',
				client_id: 'admin-cli',
				username: 'admin',
				password: 'admin'
			})
		});
		token = ((await t.json()) as { access_token: string }).access_token;
		/* Un reino limpio: el de una vuelta anterior tiene el certificado de otra clave del SP. */
		await kc(`/${REINO}`, { method: 'DELETE' });
		await kc('', { method: 'POST', body: JSON.stringify({ realm: REINO, enabled: true }) });
		descriptor = await (await fetch(`${KC}/realms/${REINO}/protocol/saml/descriptor`)).text();

		/* La consola guarda el proveedor y genera sus claves; Keycloak recibe sus metadatos. */
		expect((await saml.guardarSaml('admin', ORIGEN, datos(descriptor, true))).ok).toBe(true);
		const c = (await saml.configSaml())!;
		const rep = (await (
			await kc(`/${REINO}/client-description-converter`, {
				method: 'POST',
				body: metadatosSp(c.config),
				headers: { 'content-type': 'application/xml' }
			})
		).json()) as Record<string, unknown> & { attributes: Record<string, string> };
		rep.attributes = {
			...rep.attributes,
			'saml.server.signature': 'true',
			'saml.assertion.signature': 'true',
			'saml.client.signature': 'true',
			'saml.encrypt': 'true',
			/*
			 * xml-encryption (lo que usa node-saml) no descifra la clave con rsa-oaep de
			 * xmlenc 1.1, lo de serie en Keycloak 26: se elige RSA-OAEP-MGF1P, como ADFS.
			 */
			'saml.encryption.keyAlgorithm': 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
			/* xml-encryption hace OAEP solo con SHA-1 (Keycloak 26, de serie, SHA-256). */
			'saml.encryption.digestMethod': 'http://www.w3.org/2000/09/xmldsig#sha1',
			'saml.signature.algorithm': 'RSA_SHA256',
			saml_force_name_id_format: 'true',
			saml_name_id_format: 'persistent'
		};
		rep.protocolMappers = [
			{
				name: 'groups',
				protocol: 'saml',
				protocolMapper: 'saml-group-membership-mapper',
				config: { 'attribute.name': 'groups', 'full.path': 'false', single: 'false' }
			},
			{
				name: 'email',
				protocol: 'saml',
				protocolMapper: 'saml-user-property-mapper',
				config: { 'user.attribute': 'email', 'attribute.name': 'email' }
			}
		];
		await kc(`/${REINO}/clients`, { method: 'POST', body: JSON.stringify(rep) });
		await kc(`/${REINO}/groups`, { method: 'POST', body: JSON.stringify({ name: 'sd-admins' }) });
		await kc(`/${REINO}/users`, {
			method: 'POST',
			body: JSON.stringify({
				username: 'ana',
				email: 'ana@banco.es',
				firstName: 'Ana',
				lastName: 'Banco',
				emailVerified: true,
				enabled: true,
				groups: ['/sd-admins'],
				credentials: [{ type: 'password', value: 'Clave-de-prueba-1', temporary: false }]
			})
		});
	}, 60_000);

	afterAll(async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, saml.AJUSTE_SAML));
		await db.delete(s.sesiones).where(like(s.sesiones.oid, 'saml:%'));
	});

	it('con MFA exigida, Keycloak sin segundo factor no entra', async () => {
		const r = await entrar({ usuario: ADMIN }, '?probar=1');
		expect(r.a).toContain('saml=idp_sin_mfa');
		/* La aserción venía cifrada (el cliente cifra con el certificado de los metadatos del SP). */
		expect(Buffer.from(r.respuesta, 'base64').toString()).toContain('EncryptedAssertion');
	}, 30_000);

	it('sin exigirla: la prueba lo activa y la entrada abre sesión con el rol de su grupo', async () => {
		expect((await saml.guardarSaml('admin', ORIGEN, datos(descriptor, false))).ok).toBe(true);
		expect((await entrar({ usuario: ADMIN }, '?probar=1')).a).toBe(
			'/settings?tab=access&saml=activado#saml'
		);
		const r = await entrar({}, '?volverA=%2Fevents');
		expect(r.a).toBe('/events');
		const [ses] = await db.select().from(s.sesiones).where(like(s.sesiones.oid, 'saml:%'));
		expect(ses).toMatchObject({ correo: 'ana@banco.es', roles: ['admin'] });
	}, 60_000);
});
