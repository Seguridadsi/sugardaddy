/*
 * El SAML propio contra una base de datos de verdad y un proveedor falso
 * (saml-idp-falso.ts): guardar (pendiente, con la clave del SP cifrada),
 * identidad con roles y MFA, quitar sin dejar la consola sin entrada, y el
 * recorrido entero por las rutas: ida → ACS → fin, la prueba que lo activa,
 * la entrada normal, y los intentos que no deben abrir sesión. DATABASE_URL;
 * si no hay, se salta.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;
process.env.CLAVE_SECRETOS ||= 'ab'.repeat(32);

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('../db') : ({} as never);
const saml = hayBase ? await import('./saml-propio') : ({} as never);
const rutas = hayBase
	? {
			login: await import('../../../routes/auth/saml/login/+server'),
			acs: await import('../../../routes/auth/saml/acs/+server'),
			fin: await import('../../../routes/auth/saml/fin/+server'),
			metadatos: await import('../../../routes/auth/saml/metadata/+server')
		}
	: ({} as never);
const { eq, like } = await import('drizzle-orm');
const { ENTIDAD_IDP, SSO_IDP, metadatosIdp, parDeClaves, respuestaSaml } =
	await import('./saml-idp-falso');

const ORIGEN = 'https://consola.banco.example';
const ACS = `${ORIGEN}/auth/saml/acs`;
const SP = `${ORIGEN}/auth/saml/metadata`;
const MFA = 'http://schemas.microsoft.com/claims/multipleauthn';
let idp: Awaited<ReturnType<typeof parDeClaves>>;

const datos = (o: Record<string, unknown> = {}) => ({
	metadatos: metadatosIdp(idp.cert),
	entidad: '',
	sso: '',
	cert: '',
	nombre: 'ADFS',
	atributoRoles: 'groups',
	atributoCorreo: '',
	roles: { admin: 'sd-admins', lector: 'sd-lectores, todos' } as Record<string, string>,
	exigirMfa: true,
	contextos: '',
	pedirContexto: false,
	exigirCifrado: false,
	...o
});

async function limpiar() {
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, saml.AJUSTE_SAML));
	await db.delete(s.sesiones).where(like(s.sesiones.oid, 'saml:%'));
}

/* Un tarro de cookies mínimo, como el de SvelteKit. */
function tarro(inicial: Record<string, string> = {}) {
	const m = new Map(Object.entries(inicial));
	return {
		m,
		get: (k: string) => m.get(k),
		getAll: () => [...m].map(([name, value]) => ({ name, value })),
		set: (k: string, v: string) => void m.set(k, v),
		delete: (k: string) => void m.delete(k),
		serialize: () => ''
	};
}

/* Corre un manejador y devuelve adónde redirige. */
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

const ADMIN = { correo: 'admin@banco.es', roles: ['admin'], oid: 'local:1', soporte: false };

/* La ida: la cookie que deja y el id de la petición SAML. */
async function ida(cookies: ReturnType<typeof tarro>, locals: object, consulta = '') {
	const url = new URL(`${ORIGEN}/auth/saml/login${consulta}`);
	const a = new URL(
		await destino(() => rutas.login.GET({ url, cookies, locals } as never) as Promise<unknown>)
	);
	expect(a.origin + a.pathname).toBe(SSO_IDP);
	const xml = inflateRawSync(Buffer.from(a.searchParams.get('SAMLRequest')!, 'base64')).toString();
	return { relay: a.searchParams.get('RelayState')!, id: xml.match(/ID="([^"]+)"/)![1] };
}

async function acs(cuerpo: Record<string, string>) {
	const request = new Request(ACS, {
		method: 'POST',
		body: new URLSearchParams(cuerpo),
		headers: { 'content-type': 'application/x-www-form-urlencoded' }
	});
	return destino(() => rutas.acs.POST({ request } as never) as Promise<unknown>);
}

async function fin(a: string, cookies: ReturnType<typeof tarro>, locals: object) {
	const url = new URL(a, ORIGEN);
	return destino(() => rutas.fin.GET({ url, cookies, locals } as never) as Promise<unknown>);
}

const respuesta = (id: string, o: Record<string, unknown> = {}) =>
	respuestaSaml({
		claves: idp,
		acs: ACS,
		audiencia: SP,
		inResponseTo: id,
		contexto: MFA,
		atributos: { email: ['Ana@Banco.es'], groups: ['sd-admins'], displayName: ['Ana'] },
		...o
	});

describe.skipIf(!hayBase)('SAML propio contra base de datos', () => {
	const antes = { LOGIN_LOCAL: process.env.LOGIN_LOCAL, EDICION: process.env.EDICION };
	beforeAll(async () => {
		idp = await parDeClaves();
		await limpiar();
	});
	afterAll(async () => {
		Object.assign(process.env, antes);
		for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k];
		await limpiar();
	});

	it('valida antes de guardar', async () => {
		const mal = async (o: Record<string, unknown>) =>
			(await saml.guardarSaml('admin', ORIGEN, datos(o))).ok;
		expect(await mal({ metadatos: '<x/>' })).toBe(false);
		expect(await mal({ metadatos: '', entidad: 'x', sso: SSO_IDP, cert: '' })).toBe(false);
		expect(
			await mal({ metadatos: '', entidad: 'x', sso: 'http://idp.example.com', cert: idp.cert })
		).toBe(false);
		expect(await mal({ atributoRoles: 'con espacios' })).toBe(false);
		expect(await mal({ roles: { lector: 'x' } })).toBe(false);
		expect(await mal({ pedirContexto: true })).toBe(false);
		expect(await saml.estadoSaml()).toBeNull();
	});

	it('guarda pendiente, con la clave del SP cifrada, y la conserva al cambiar', async () => {
		expect((await saml.guardarSaml('admin', ORIGEN, datos())).ok).toBe(true);
		const e = await saml.estadoSaml();
		expect(e).toMatchObject({
			entidad: ENTIDAD_IDP,
			sso: SSO_IDP,
			spEntidad: SP,
			acs: ACS,
			activo: false,
			legible: true,
			roles: { admin: ['sd-admins'], lector: ['sd-lectores', 'todos'] }
		});
		expect(e?.certificados[0]?.huella).toBeTruthy();
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, saml.AJUSTE_SAML));
		expect(JSON.stringify(f.valor)).not.toContain('PRIVATE KEY');
		expect(await saml.samlActivo()).toBeNull();
		const cert = e!.certSp;

		/* A mano, sin certificado y el mismo proveedor: se quedan los de antes y la clave del SP. */
		expect(
			(
				await saml.guardarSaml(
					'admin',
					ORIGEN,
					datos({ metadatos: '', entidad: ENTIDAD_IDP, sso: SSO_IDP, nombre: 'Banco SSO' })
				)
			).ok
		).toBe(true);
		const e2 = await saml.estadoSaml();
		expect(e2?.certSp).toBe(cert);
		expect(e2?.certs).toEqual(e?.certs);
		expect(e2?.nombre).toBe('Banco SSO');
	});

	it('los metadatos del SP se descargan', async () => {
		const r = (await rutas.metadatos.GET({
			url: new URL(`${SP}?descargar`)
		} as never)) as Response;
		expect(r.headers.get('content-type')).toContain('samlmetadata+xml');
		expect(r.headers.get('content-disposition')).toContain('attachment');
		expect(await r.text()).toContain(`Location="${ACS}"`);
	});

	it('identidad: roles por atributo, MFA exigida, correo, NameID transitorio', async () => {
		const g = (await saml.configSaml())!.guardado;
		const a = {
			nameId: 'u-1',
			formato: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
			idAsercion: '_a',
			contextos: [MFA],
			atributos: { email: ['Ana@Banco.es'], groups: ['sd-admins', 'todos'] }
		};
		const r = saml.identidadSaml(a, g);
		expect(r).toMatchObject({ correo: 'ana@banco.es', roles: ['lector', 'admin'] });
		expect('oid' in r && r.oid).toMatch(/^saml:[0-9a-f]{8}:u-1$/);
		expect(saml.identidadSaml({ ...a, contextos: ['x'] }, g)).toEqual({ rechazo: 'sin_mfa' });
		expect(saml.identidadSaml({ ...a, atributos: { email: ['a@b.es'] } }, g)).toEqual({
			rechazo: 'sin_rol'
		});
		expect(saml.identidadSaml({ ...a, atributos: { groups: ['todos'] } }, g)).toEqual({
			rechazo: 'sin_correo'
		});
		expect(
			saml.identidadSaml(
				{ ...a, formato: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient' },
				g
			)
		).toEqual({ rechazo: 'sin_oid' });
		expect('oid' in saml.identidadSaml({ ...a, contextos: [] }, { ...g, exigirMfa: false })).toBe(
			true
		);
	});

	it('sin probar no hay botón ni entrada normal', async () => {
		const url = new URL(`${ORIGEN}/auth/saml/login`);
		expect(
			await destino(
				() => rutas.login.GET({ url, cookies: tarro(), locals: {} } as never) as Promise<unknown>
			)
		).toBe('/sign-in');
	});

	it('la prueba con un administrador lo activa; sin rol admin, no', async () => {
		/* Sin rol admin en el proveedor: vuelve a Ajustes con el motivo. */
		let k = tarro();
		let i = await ida(k, { usuario: ADMIN }, '?probar=1');
		let r = await respuestaSaml({
			claves: idp,
			acs: ACS,
			audiencia: SP,
			inResponseTo: i.id,
			contexto: MFA,
			atributos: { email: ['luis@banco.es'], groups: ['todos'] }
		});
		expect(await acs({ SAMLResponse: r, RelayState: i.relay })).toContain('saml=sin-admin');
		expect((await saml.estadoSaml())?.activo).toBe(false);

		k = tarro();
		i = await ida(k, { usuario: ADMIN }, '?probar=1');
		r = await respuesta(i.id);
		const a = await acs({ SAMLResponse: r, RelayState: i.relay });
		expect(a).toMatch(/^\/auth\/saml\/fin\?ficha=/);
		expect(await fin(a, k, { usuario: ADMIN })).toBe('/settings?tab=access&saml=activado#saml');
		expect((await saml.samlActivo())?.guardado.activadoPor).toBe('ana@banco.es');
	});

	it('entrada normal: abre sesión y vuelve adonde iba', async () => {
		const k = tarro();
		const i = await ida(k, {}, '?volverA=%2Fevents');
		const a = await acs({ SAMLResponse: await respuesta(i.id), RelayState: i.relay });
		expect(await fin(a, k, {})).toBe('/events');
		const [ses] = await db.select().from(s.sesiones).where(like(s.sesiones.oid, 'saml:%'));
		expect(ses).toMatchObject({ correo: 'ana@banco.es', factor: 'idp' });
	});

	it('no abre sesión: repetida, en otro navegador, sin ida, sin MFA o mal firmada', async () => {
		/* La misma respuesta otra vez: su ida ya se gastó. */
		let k = tarro();
		let i = await ida(k, {});
		const r = await respuesta(i.id);
		const a = await acs({ SAMLResponse: r, RelayState: i.relay });
		expect(await acs({ SAMLResponse: r, RelayState: i.relay })).toBe('/sign-in?error=caducado');

		/* La ficha buena, en un navegador sin la cookie de esa ida. */
		expect(await fin(a, tarro(), {})).toBe('/sign-in?error=caducado');
		/* Y la ficha ya no vale ni con la cookie buena. */
		expect(await fin(a, k, {})).toBe('/sign-in?error=caducado');

		/* Iniciada por el proveedor (sin RelayState de una ida). */
		expect(await acs({ SAMLResponse: await respuesta('_x') })).toBe('/sign-in?error=caducado');

		/* Sin MFA. */
		k = tarro();
		i = await ida(k, {});
		expect(
			await acs({
				SAMLResponse: await respuesta(i.id, {
					contexto: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
				}),
				RelayState: i.relay
			})
		).toBe('/sign-in?error=idp_sin_mfa');

		/* Firmada por otro. */
		k = tarro();
		i = await ida(k, {});
		expect(
			await acs({
				SAMLResponse: await respuesta(i.id, { claves: await parDeClaves('Atacante') }),
				RelayState: i.relay
			})
		).toBe('/sign-in?error=idp_canje');

		const fallos = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.accion, 'sign-in denied'));
		expect(fallos.some((f) => JSON.stringify(f).includes('"via":"saml"'))).toBe(true);
	});

	it('no se quita si es la única entrada; con login local sí, y cierra sus sesiones', async () => {
		process.env.LOGIN_LOCAL = '0';
		delete process.env.EDICION;
		expect((await saml.quitarSaml('admin')).ok).toBe(false);
		process.env.LOGIN_LOCAL = '1';
		expect((await saml.quitarSaml('admin')).ok).toBe(true);
		expect(await saml.estadoSaml()).toBeNull();
		const abiertas = (
			await db.select().from(s.sesiones).where(like(s.sesiones.oid, 'saml:%'))
		).filter((x) => !x.cerrada);
		expect(abiertas).toEqual([]);
	});
});
