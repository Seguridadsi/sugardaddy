/*
 * El OIDC propio contra una base de datos de verdad: guardar (pendiente, con el
 * secreto cifrado), activar tras la prueba, la identidad con roles y MFA, y que
 * quitarlo no deje la consola sin entrada. DATABASE_URL; si no hay, se salta.
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
const hayBase = !!process.env.DATABASE_URL;
process.env.CLAVE_SECRETOS ||= 'ab'.repeat(32);

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('../db') : ({} as never);
const oidc = hayBase ? await import('./oidc-propio') : ({} as never);
const { eq } = await import('drizzle-orm');

const DATOS = {
	emisor: 'https://idp.example.com/realms/banco/',
	clientId: 'sugardaddy',
	secreto: 'secreto-del-cliente-123',
	nombre: 'Keycloak',
	alcances: 'profile email groups',
	claim: 'groups',
	roles: { admin: 'sd-admins', lector: 'sd-lectores, todos' } as Record<string, string>,
	exigirMfa: true,
	acr: ''
};
const vale = async () => ({});

async function limpiar() {
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, oidc.AJUSTE_OIDC));
}

describe.skipIf(!hayBase)('OIDC propio contra base de datos', () => {
	const antes = { LOGIN_LOCAL: process.env.LOGIN_LOCAL, EDICION: process.env.EDICION };
	beforeAll(limpiar);
	afterAll(async () => {
		Object.assign(process.env, antes);
		for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k];
		await limpiar();
	});

	it('valida antes de guardar', async () => {
		const mal = async (d: Partial<typeof DATOS>) =>
			(await oidc.guardarOidc('admin', { ...DATOS, ...d }, vale)).ok;
		expect(await mal({ emisor: 'http://idp.example.com' })).toBe(false);
		expect(await mal({ clientId: '' })).toBe(false);
		expect(await mal({ claim: 'grupos con espacios' })).toBe(false);
		expect(await mal({ roles: { lector: 'x' } })).toBe(false);
		const r = await oidc.guardarOidc('admin', DATOS, async () => {
			throw new Error('Not found.');
		});
		expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Not found.') });
		expect(await oidc.estadoOidc()).toBeNull();
	});

	it('guarda pendiente, con el secreto cifrado; sin secreto se queda el de antes', async () => {
		expect((await oidc.guardarOidc('admin', DATOS, vale)).ok).toBe(true);
		const e = await oidc.estadoOidc();
		expect(e).toMatchObject({
			emisor: 'https://idp.example.com/realms/banco',
			activo: false,
			legible: true,
			roles: { admin: ['sd-admins'], lector: ['sd-lectores', 'todos'] }
		});
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, oidc.AJUSTE_OIDC));
		expect(JSON.stringify(f.valor)).not.toContain(DATOS.secreto);
		expect(await oidc.oidcActivo()).toBeNull();

		expect(
			(await oidc.guardarOidc('admin', { ...DATOS, secreto: '', nombre: 'SSO' }, vale)).ok
		).toBe(true);
		expect((await oidc.configOidc())?.config.secret).toBe(DATOS.secreto);
		/* Otro cliente sin secreto: no. */
		expect(
			(await oidc.guardarOidc('admin', { ...DATOS, secreto: '', clientId: 'otro' }, vale)).ok
		).toBe(false);
	});

	it('activa tras la prueba', async () => {
		expect(await oidc.activarOidc('admin', 'ana@banco.es')).toBe(true);
		expect((await oidc.oidcActivo())?.guardado.activadoPor).toBe('ana@banco.es');
	});

	it('identidad: roles por grupo, MFA exigida, correo y oid con huella del emisor', async () => {
		const g = (await oidc.configOidc())!.guardado;
		const base = { sub: 'u-1', email: 'Ana@Banco.es', name: 'Ana', amr: ['pwd', 'otp'] };
		const r = oidc.identidadOidc({ ...base, groups: ['sd-admins', 'todos'] }, g);
		expect(r).toMatchObject({ correo: 'ana@banco.es', nombre: 'Ana', roles: ['lector', 'admin'] });
		expect('oid' in r && r.oid).toMatch(/^oidc:[0-9a-f]{8}:u-1$/);
		expect(oidc.identidadOidc({ ...base, amr: ['pwd'], groups: ['sd-admins'] }, g)).toEqual({
			rechazo: 'sin_mfa'
		});
		expect(oidc.identidadOidc({ ...base, groups: ['otro'] }, g)).toEqual({ rechazo: 'sin_rol' });
		expect(oidc.identidadOidc({ ...base, email: undefined, groups: ['todos'] }, g)).toEqual({
			rechazo: 'sin_correo'
		});
		expect(oidc.identidadOidc({ groups: ['todos'], amr: ['mfa'] }, g)).toEqual({
			rechazo: 'sin_oid'
		});
		/* Sin exigir MFA, pasa sin ella. */
		expect(
			'oid' in
				oidc.identidadOidc({ ...base, amr: [], groups: ['todos'] }, { ...g, exigirMfa: false })
		).toBe(true);
	});

	it('no se quita si es la única entrada; con login local, sí', async () => {
		process.env.LOGIN_LOCAL = '0';
		delete process.env.EDICION;
		const r = await oidc.quitarOidc('admin');
		expect(r.ok).toBe(false);
		process.env.LOGIN_LOCAL = '1';
		expect((await oidc.quitarOidc('admin')).ok).toBe(true);
		expect(await oidc.estadoOidc()).toBeNull();
	});
});
