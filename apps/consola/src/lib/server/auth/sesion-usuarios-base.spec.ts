/*
 * CON-2 del análisis de seguridad (docs/seguridad): una sesión de un usuario
 * local lleva los roles de ahora, y se acaba si el usuario desaparece o le
 * cambian o restablecen la contraseña. Contra una base de verdad (DATABASE_URL
 * de .env); si no hay, se salta.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* sin .env */
}
const hayBase = !!process.env.DATABASE_URL;
vi.mock('$env/dynamic/private', () => ({ env: { ...process.env, LOGIN_LOCAL: '1' } }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('../db') : ({} as never);
const local = hayBase ? await import('./local') : ({} as never);
const sesion = hayBase ? await import('./sesion') : ({} as never);
const { like } = await import('drizzle-orm');

const P = 'zz-sesiones';
const clave = 'una contraseña larga de prueba';

/* Unas cookies de mentira: lo justo para abrir y leer una sesión. */
function galletas(): Cookies {
	const m = new Map<string, string>();
	return {
		get: (n: string) => m.get(n),
		set: (n: string, v: string) => void m.set(n, v),
		delete: (n: string) => void m.delete(n)
	} as unknown as Cookies;
}

async function entrar(usuario: string) {
	const r = await local.verificar(usuario, clave);
	if (!r.ok) throw new Error('no entra');
	const c = galletas();
	await sesion.abrir(c, r.identidad, true);
	return { c, id: r.id };
}

describe.skipIf(!hayBase)('las sesiones de los usuarios locales', () => {
	const limpiar = async () => {
		await db.delete(s.sesiones).where(like(s.sesiones.correo, `${P}%`));
		await db.delete(s.usuariosLocales).where(like(s.usuariosLocales.usuario, `${P}%`));
	};
	beforeAll(async () => {
		await limpiar();
		for (const [u, roles] of [
			['a', ['admin']],
			['b', ['operador']],
			['c', ['lector']]
		] as const)
			await local.crear('tester', {
				usuario: `${P}-${u}`,
				nombre: u,
				correo: `${P}-${u}@ejemplo.com`,
				roles: [...roles],
				clave
			});
	});
	afterAll(async () => {
		if (!process.env.CONSERVAR) await limpiar();
	});

	it('los roles son los de ahora, no los de cuando entró', async () => {
		const { c, id } = await entrar(`${P}-b`);
		expect((await sesion.leer(c))?.roles).toEqual(['operador']);
		const r = await local.fijarRoles('tester', id, ['lector']);
		expect(r.ok).toBe(true);
		expect((await sesion.leer(c))?.roles).toEqual(['lector']);
	});

	it('al restablecerle la contraseña, su sesión se acaba', async () => {
		const { c, id } = await entrar(`${P}-c`);
		expect(await sesion.leer(c)).not.toBeNull();
		expect((await local.restablecer('tester', id, 'otra contraseña larga de prueba')).ok).toBe(
			true
		);
		expect(await sesion.leer(c)).toBeNull();
	});

	it('al cambiar la suya, sigue en la sesión desde la que la cambia y las demás se cierran', async () => {
		const una = await entrar(`${P}-a`);
		const otra = await entrar(`${P}-a`);
		const r = await local.cambiarClavePropia(
			'tester',
			una.id,
			clave,
			'nueva contraseña larga de prueba',
			una.c.get(sesion.COOKIE_SESION)
		);
		expect(r.ok).toBe(true);
		expect(await sesion.leer(una.c)).not.toBeNull();
		expect(await sesion.leer(otra.c)).toBeNull();
	});

	it('si el usuario ya no existe, no hay sesión', async () => {
		await local.crear('tester', {
			usuario: `${P}-d`,
			nombre: 'd',
			correo: `${P}-d@ejemplo.com`,
			roles: ['lector'],
			clave
		});
		const { c, id } = await entrar(`${P}-d`);
		expect((await local.retirar('tester', id)).ok).toBe(true);
		expect(await sesion.leer(c)).toBeNull();
	});
});
