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
		expect(await ep.configPropia()).toEqual({ tenant: TENANT, clientId: APP, secret: SECRETO });

		await ep.activarEntraPropio('admin@local', 'luis@kebaps.es');
		expect(await ep.configActiva()).toEqual({
			modo: 'propio',
			config: { tenant: TENANT, clientId: APP, secret: SECRETO }
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
		payload = { oid: 'luis', preferred_username: 'luis@kebaps.es', roles: ['lector'] };
		const r = await ep.canjearCodigo(
			activa!,
			{ codigo: 'c', redirectUri: 'https://x/auth/callback', verificador: 'v', nonce: 'n' },
			null
		);
		expect(r).toMatchObject({ correo: 'luis@kebaps.es', roles: ['lector'] });
		expect(canjes[0]).toMatchObject({ tenant: TENANT, clientId: APP });

		await ep.quitarEntraPropio('admin@local');
		expect(await ep.configActiva()).toMatchObject({ modo: 'seguridadsi' });
	});
});
