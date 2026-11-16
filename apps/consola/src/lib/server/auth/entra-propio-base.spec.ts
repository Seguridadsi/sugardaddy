/*
 * El Entra propio del cliente contra una base de datos de verdad: guardarlo
 * (validado, con el secreto cifrado), que no se use hasta probarlo, que manda
 * sobre el Entra de SeguridadSI, y quitarlo. Microsoft se sustituye por un
 * doble. DATABASE_URL (del entorno o de .env); si no hay, se salta.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;
process.env.CLAVE_SECRETOS ||= '0'.repeat(64);

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

let payload: Record<string, unknown> = {};
const canjes: { tenant: string; clientId: string; secret: string }[] = [];
vi.mock('@sugardaddy/entra', async (original) => ({
	...(await original<typeof import('@sugardaddy/entra')>()),
	canjear: async (c: { tenant: string; clientId: string; secret: string }) => {
		canjes.push(c);
		return payload;
	}
}));

const { db, schema: s } = hayBase ? await import('../db') : ({} as never);
const ep = hayBase ? await import('./entra-propio') : ({} as never);
const b2b = hayBase ? await import('./b2b') : ({} as never);
const { eq } = await import('drizzle-orm');

const TENANT = '9b0c3a52-1111-4222-8333-444455556666';
const APP = 'a1b2c3d4-0000-4000-8000-000000000001';
const SECRETO = 'secreto-de-la-aplicacion-0123456789';
const existe = async (): Promise<'si' | 'no' | 'sin-red'> => 'si';
const ENTORNO = [
	'ENTRA_TENANT_ID',
	'ENTRA_CLIENT_ID',
	'ENTRA_CLIENT_SECRET',
	'ENTRA_GRUPO_CLIENTE'
];

describe.skipIf(!hayBase)('Entra propio del cliente', () => {
	let previo: unknown;
	const entorno: Record<string, string | undefined> = {};

	beforeAll(async () => {
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'entra_propio'));
		previo = f?.valor;
		for (const k of ENTORNO) entorno[k] = process.env[k];
	});

	afterAll(async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'entra_propio'));
		if (previo) await db.insert(s.ajustes).values({ clave: 'entra_propio', valor: previo });
		for (const k of ENTORNO) process.env[k] = entorno[k];
	});

	beforeEach(async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'entra_propio'));
		for (const k of ENTORNO) delete process.env[k];
		canjes.length = 0;
	});

	it('valida lo que se pega y comprueba que el tenant existe', async () => {
		const g = (d: Partial<{ tenant: string; clientId: string; secreto: string }>, c = existe) =>
			ep.guardarEntraPropio(
				'admin@local',
				{ tenant: TENANT, clientId: APP, secreto: SECRETO, ...d },
				c
			);
		expect(await g({ tenant: 'no es un tenant' })).toMatchObject({ ok: false });
		expect(await g({ clientId: 'abc' })).toMatchObject({ ok: false });
		expect(await g({ secreto: '' })).toMatchObject({
			ok: false,
			error: 'The application secret is missing.'
		});
		expect(await g({}, async () => 'no')).toMatchObject({ ok: false });
		expect(await g({}, async () => 'sin-red')).toMatchObject({ ok: false });
		expect(await ep.estadoEntraPropio()).toBeNull();
		expect(await g({ tenant: 'kebaps.onmicrosoft.com' })).toEqual({ ok: true });
	});

	it('guardado queda pendiente: no se usa hasta probarlo', async () => {
		await ep.guardarEntraPropio(
			'admin@local',
			{ tenant: TENANT, clientId: APP, secreto: SECRETO },
			existe
		);
		const e = await ep.estadoEntraPropio();
		expect(e).toMatchObject({
			tenant: TENANT,
			clientId: APP,
			activo: false,
			final: '6789',
			legible: true
		});
		expect(e).not.toHaveProperty('secreto');
		/* En la base de datos el secreto va cifrado. */
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'entra_propio'));
		expect(JSON.stringify(f.valor)).not.toContain(SECRETO);

		expect(await ep.configActiva()).toBeNull();
		const mfa = { exigirMfa: true, modoMfa: 'exigida', contextoAuth: null };
		expect(await ep.configPropia()).toEqual({
			tenant: TENANT,
			clientId: APP,
			secret: SECRETO,
			...mfa
		});

		await ep.activarEntraPropio('admin@local', 'luis@kebaps.es');
		expect(await ep.configActiva()).toEqual({
			modo: 'propio',
			config: { tenant: TENANT, clientId: APP, secret: SECRETO, ...mfa }
		});
		expect(await ep.estadoEntraPropio()).toMatchObject({
			activo: true,
			activadoPor: 'luis@kebaps.es'
		});
	});

	it('cambiarlo vuelve a dejarlo pendiente; sin secreto conserva el que había', async () => {
		await ep.guardarEntraPropio(
			'admin@local',
			{ tenant: TENANT, clientId: APP, secreto: SECRETO },
			existe
		);
		await ep.activarEntraPropio('admin@local', 'luis@kebaps.es');
		expect(
			await ep.guardarEntraPropio(
				'admin@local',
				{ tenant: 'kebaps.onmicrosoft.com', clientId: APP, secreto: '' },
				existe
			)
		).toEqual({ ok: true });
		expect(await ep.estadoEntraPropio()).toMatchObject({
			activo: false,
			tenant: 'kebaps.onmicrosoft.com'
		});
		expect((await ep.configPropia())?.secret).toBe(SECRETO);
		/* Otra aplicación sin secreto: no vale el de la anterior. */
		const otra = 'a1b2c3d4-0000-4000-8000-000000000002';
		expect(
			await ep.guardarEntraPropio(
				'admin@local',
				{ tenant: TENANT, clientId: otra, secreto: '' },
				existe
			)
		).toMatchObject({ ok: false });
	});

	it('el propio activo manda sobre el de SeguridadSI; sin él, vale el del .env', async () => {
		Object.assign(process.env, {
			ENTRA_TENANT_ID: 'tenant-seguridadsi',
			ENTRA_CLIENT_ID: 'app-seguridadsi',
			ENTRA_CLIENT_SECRET: 'x',
			ENTRA_GRUPO_CLIENTE: 'grupo-kebaps'
		});
		expect(await ep.configActiva()).toMatchObject({ modo: 'seguridadsi', grupo: 'grupo-kebaps' });

		await ep.guardarEntraPropio(
			'admin@local',
			{ tenant: TENANT, clientId: APP, secreto: SECRETO },
			existe
		);
		expect(await ep.configActiva()).toMatchObject({ modo: 'seguridadsi' });
		await ep.activarEntraPropio('admin@local', 'luis@kebaps.es');
		const activa = await ep.configActiva();
		expect(activa).toMatchObject({ modo: 'propio' });

		/* Con el propio, entra quien trae rol aunque no esté en ningún grupo. */
		payload = {
			oid: 'luis',
			preferred_username: 'luis@kebaps.es',
			roles: ['lector'],
			amr: ['pwd', 'mfa']
		};
		const r = await ep.canjearCodigo(
			activa!,
			{ codigo: 'c', redirectUri: 'https://x/auth/callback', verificador: 'v', nonce: 'n' },
			{ grupo: null, invitado: null }
		);
		expect(r).toMatchObject({ correo: 'luis@kebaps.es', roles: ['lector'] });
		expect(canjes[0]).toMatchObject({ tenant: TENANT, clientId: APP });

		await ep.quitarEntraPropio('admin@local');
		expect(await ep.configActiva()).toMatchObject({ modo: 'seguridadsi' });
	});

	it('MFA exigida de serie; apagarla pide confirmación y queda auditado', async () => {
		const g = (d: Record<string, unknown>) =>
			ep.guardarEntraPropio(
				'admin@local',
				{ tenant: TENANT, clientId: APP, secreto: SECRETO, ...d },
				existe
			);
		expect(await g({ contextoAuth: 'x9' })).toMatchObject({ ok: false });
		expect(await g({ exigirMfa: false })).toMatchObject({ ok: false });
		expect(await ep.estadoEntraPropio()).toBeNull();

		expect(await g({ contextoAuth: 'C1' })).toEqual({ ok: true });
		await ep.activarEntraPropio('admin@local', 'luis@kebaps.es');
		const activa = await ep.configActiva();
		expect(activa).toMatchObject({
			modo: 'propio',
			config: { exigirMfa: true, contextoAuth: 'c1' }
		});
		const canje = (p: Record<string, unknown>) => {
			payload = p;
			return ep.canjearCodigo(
				activa!,
				{ codigo: 'c', redirectUri: 'https://x/auth/callback', verificador: 'v', nonce: 'n' },
				{ grupo: null, invitado: null }
			);
		};
		const luis = { oid: 'luis', preferred_username: 'luis@kebaps.es', roles: ['lector'] };
		expect(await canje({ ...luis, amr: ['pwd'] })).toEqual({ rechazo: 'sin_mfa' });
		expect(await canje({ ...luis, acrs: ['c2'] })).toEqual({ rechazo: 'sin_mfa' });
		expect(await canje({ ...luis, acrs: ['c1'] })).toMatchObject({ roles: ['lector'] });

		const antes = new Date();
		expect(await g({ exigirMfa: false, confirmarSinMfa: true })).toEqual({ ok: true });
		expect(await ep.estadoEntraPropio()).toMatchObject({ exigirMfa: false, activo: false });
		const filas = await db
			.select()
			.from(s.auditoria)
			.where(
				eq(s.auditoria.accion, 'Microsoft sign-in (own Entra): two-factor from Entra not required')
			);
		expect(filas.some((f: { cuando: Date }) => f.cuando >= new Date(antes.getTime() - 1000))).toBe(
			true
		);
	});

	it('una configuración de antes (sin el campo) deja entrar sin MFA, lo apunta y se puede activar', async () => {
		await ep.guardarEntraPropio(
			'admin@local',
			{ tenant: TENANT, clientId: APP, secreto: SECRETO },
			existe
		);
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'entra_propio'));
		const { exigirMfa: _e, contextoAuth: _c, ...viejo } = f.valor as Record<string, unknown>;
		await db
			.update(s.ajustes)
			.set({ valor: { ...viejo, activo: true } })
			.where(eq(s.ajustes.clave, 'entra_propio'));
		expect(await ep.estadoEntraPropio()).toMatchObject({ modoMfa: 'heredada', exigirMfa: false });
		const activa = await ep.configActiva();
		expect(activa).toMatchObject({ modo: 'propio', config: { modoMfa: 'heredada' } });

		const antes = new Date(Date.now() - 1000);
		const canje = (p: Record<string, unknown>) => {
			payload = p;
			return ep.canjearCodigo(
				activa!,
				{ codigo: 'c', redirectUri: 'https://x/auth/callback', verificador: 'v', nonce: 'n' },
				{ grupo: null, invitado: null }
			);
		};
		const luis = { oid: 'luis', preferred_username: 'luis@kebaps.es', roles: ['lector'] };
		expect(await canje({ ...luis, amr: ['pwd'] })).toMatchObject({ correo: 'luis@kebaps.es' });
		const sinMfa = async () =>
			(await db.select().from(s.auditoria).where(eq(s.auditoria.accion, ep.ACCION_SIN_MFA))).filter(
				(x: { cuando: Date; quien: string }) => x.cuando >= antes && x.quien === 'luis@kebaps.es'
			).length;
		expect(await sinMfa()).toBe(1);
		/* Con MFA no se apunta nada. */
		await canje({ ...luis, amr: ['pwd', 'mfa'] });
		expect(await sinMfa()).toBe(1);

		/* Activar la exigencia (tras la prueba con MFA, en auth/callback) la deja exigida. */
		await ep.activarExigenciaMfa('admin@local', 'luis@kebaps.es', 'c1');
		expect(await ep.estadoEntraPropio()).toMatchObject({
			modoMfa: 'exigida',
			activo: true,
			contextoAuth: 'c1'
		});
		const ya = await ep.configActiva();
		payload = { ...luis, amr: ['pwd'] };
		expect(
			await ep.canjearCodigo(
				ya!,
				{ codigo: 'c', redirectUri: 'https://x/auth/callback', verificador: 'v', nonce: 'n' },
				{ grupo: null, invitado: null }
			)
		).toEqual({ rechazo: 'sin_mfa' });
	});

	describe('salir del B2B (b2b.ts)', () => {
		const limpiar = () => db.delete(s.ajustes).where(eq(s.ajustes.clave, 'entra_b2b'));
		beforeEach(async () => {
			await limpiar();
			Object.assign(process.env, {
				ENTRA_TENANT_ID: 'tenant-seguridadsi',
				ENTRA_CLIENT_ID: 'app-seguridadsi',
				ENTRA_CLIENT_SECRET: 'x',
				ENTRA_GRUPO_CLIENTE: 'grupo-kebaps'
			});
			delete process.env.LOGIN_LOCAL;
			delete process.env.EDICION;
		});
		afterAll(limpiar);

		it('no se retira sin el Entra propio activo: nadie se queda fuera', async () => {
			expect(await b2b.estadoB2B()).toBe('activo');
			expect(
				await b2b.retirarB2B('ana@kebaps.es', null, await ep.estadoEntraPropio())
			).toMatchObject({ ok: false });
			await ep.guardarEntraPropio(
				'admin@local',
				{ tenant: TENANT, clientId: APP, secreto: SECRETO },
				existe
			);
			/* Guardado pero sin probar tampoco. */
			expect(
				await b2b.retirarB2B('ana@kebaps.es', null, await ep.estadoEntraPropio())
			).toMatchObject({ ok: false });
			expect(await b2b.estadoB2B()).toBe('activo');
		});

		it('retirado, el Entra de SeguridadSI no vale aunque siga en el .env ni aunque falle el propio', async () => {
			await ep.guardarEntraPropio(
				'admin@local',
				{ tenant: TENANT, clientId: APP, secreto: SECRETO },
				existe
			);
			await ep.activarEntraPropio('admin@local', 'luis@kebaps.es');
			expect(await b2b.retirarB2B('luis@kebaps.es', null, await ep.estadoEntraPropio())).toEqual({
				ok: true
			});
			expect(await b2b.estadoB2B()).toBe('retirado');
			expect(await ep.configActiva()).toMatchObject({ modo: 'propio' });

			/* Sin login local, quitar el propio dejaría la consola sin entrada: no se deja. */
			expect(await ep.quitarEntraPropio('luis@kebaps.es')).toMatchObject({ ok: false });
			process.env.LOGIN_LOCAL = '1';
			expect(await ep.quitarEntraPropio('luis@kebaps.es')).toEqual({ ok: true });
			expect(await ep.configActiva()).toBeNull();
		});
	});
});
