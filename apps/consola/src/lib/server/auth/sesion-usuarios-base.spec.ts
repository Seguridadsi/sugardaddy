/*
 * CON-2 del análisis de seguridad (docs/seguridad): una sesión de un usuario
 * local lleva los roles de ahora, y se acaba si el usuario desaparece o le
 * cambian o restablecen la contraseña. Contra una base de verdad (DATABASE_URL
 * de .env); si no hay, se salta.
 */
import { createHash } from 'node:crypto';
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
const { eq, like, sql } = await import('drizzle-orm');

const P = 'zz-sesiones';
const clave = 'una contraseña larga de prueba';

type Opciones = Parameters<Cookies['set']>[2];
/* Unas cookies de mentira: lo justo para abrir y leer una sesión (y ver con qué opciones). */
function galletas(): Cookies & { opciones: Map<string, Opciones> } {
	const m = new Map<string, string>();
	const opciones = new Map<string, Opciones>();
	return {
		opciones,
		get: (n: string) => m.get(n),
		set: (n: string, v: string, o: Opciones) => {
			m.set(n, v);
			opciones.set(n, o);
		},
		delete: (n: string) => void m.delete(n)
	} as unknown as Cookies & { opciones: Map<string, Opciones> };
}
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

async function entrar(usuario: string) {
	const r = await local.verificar(usuario, clave);
	if (!r.ok) throw new Error('no entra');
	const c = galletas();
	await sesion.abrir(c, r.identidad);
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
			sesion.sesionActual(una.c) ?? undefined
		);
		expect(r.ok).toBe(true);
		expect(await sesion.leer(una.c)).not.toBeNull();
		expect(await sesion.leer(otra.c)).toBeNull();
	});

	/*
	 * Cuánto dura una sesión, para que nadie lo tenga que adivinar: media hora sin
	 * actividad, ocho horas como mucho. Vive en la base, no en el proceso: un
	 * reinicio de la consola (una actualización) no la cierra, porque quien la lee
	 * después solo tiene la cookie y la tabla.
	 */
	it('dura media hora sin actividad y ocho horas como mucho, y no depende del proceso', async () => {
		expect(sesion.INACTIVIDAD_MS).toBe(30 * 60_000);
		expect(sesion.MAXIMO_MS).toBe(8 * 60 * 60_000);
		await local.crear('tester', {
			usuario: `${P}-e`,
			nombre: 'e',
			correo: `${P}-e@ejemplo.com`,
			roles: ['lector'],
			clave
		});
		const { c } = await entrar(`${P}-e`);
		const ahora = Date.now();
		/* Otra «consola» que arranca de cero con la misma cookie: la sesión sigue. */
		const tras = galletas();
		tras.set(sesion.COOKIE_SESION, c.get(sesion.COOKIE_SESION)!, { path: '/' });
		expect(await sesion.leer(tras, ahora)).not.toBeNull();
		/* Cada lectura cuenta como actividad: 29 minutos después de la última, sigue. */
		expect(await sesion.leer(tras, ahora + 29 * 60_000)).not.toBeNull();
		expect(await sesion.leer(tras, ahora + 58 * 60_000)).not.toBeNull();
		/* 31 minutos sin hacer nada: fuera, y la cookie se retira. */
		expect(await sesion.leer(tras, ahora + 58 * 60_000 + 31 * 60_000)).toBeNull();
		expect(tras.get(sesion.COOKIE_SESION)).toBeUndefined();
		/* Y aunque no pare, a las ocho horas de entrar se acaba. */
		const otra = await entrar(`${P}-e`);
		let t = ahora;
		while (t < ahora + 8 * 60 * 60_000 - 20 * 60_000) {
			t += 20 * 60_000;
			expect(await sesion.leer(otra.c, t)).not.toBeNull();
		}
		expect(await sesion.leer(otra.c, ahora + 8 * 60 * 60_000 + 60_000)).toBeNull();
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
	/*
	 * Plan de fortificación, 0.4: en la base va la huella (SHA-256) del id, no el
	 * id; la cookie es __Host-, Secure siempre, HttpOnly y SameSite=Lax.
	 */
	it('en la base va la huella del id, no el id, y la cookie es __Host- y Secure', async () => {
		const { c } = await entrar(`${P}-b`);
		expect(sesion.COOKIE_SESION).toBe('__Host-sd_sesion');
		const id = c.get(sesion.COOKIE_SESION)!;
		expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(c.opciones.get(sesion.COOKIE_SESION)).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax'
		});
		expect(c.opciones.get(sesion.COOKIE_SESION)).not.toHaveProperty('domain');
		expect(await db.select().from(s.sesiones).where(eq(s.sesiones.id, id))).toHaveLength(0);
		const [fila] = await db
			.select()
			.from(s.sesiones)
			.where(eq(s.sesiones.id, sha256(id)));
		expect(fila?.correo).toBe(`${P}-b@ejemplo.com`);
		expect((await sesion.leer(c))?.sesion).toBe(sha256(id));
		/* Con la huella en la cookie no se entra: hace falta el id. */
		const robada = galletas();
		robada.set(sesion.COOKIE_SESION, sha256(id), { path: '/' });
		expect(await sesion.leer(robada)).toBeNull();
		/* Y al salir se cierra en la base. */
		await sesion.cerrar(c);
		const [cerrada] = await db
			.select()
			.from(s.sesiones)
			.where(eq(s.sesiones.id, sha256(id)));
		expect(cerrada?.cerrada).not.toBeNull();
	});

	it('la migración 0062 pasa a huella las sesiones de antes y la cookie vieja sigue valiendo', async () => {
		/* Una sesión como las de antes: el id en claro en la tabla. */
		const id = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
		expect(id).toHaveLength(43);
		await db.insert(s.sesiones).values({
			id,
			oid: 'e2e:migracion',
			correo: `${P}-migracion@ejemplo.com`,
			nombre: 'm',
			roles: ['lector']
		});
		const migracion = readFileSync('drizzle/0062_sesiones_huella.sql', 'utf8');
		await db.execute(sql.raw(migracion));
		/* Repetirla no cambia nada: una huella no tiene la forma de un id. */
		await db.execute(sql.raw(migracion));
		const filas = await db
			.select({ id: s.sesiones.id })
			.from(s.sesiones)
			.where(eq(s.sesiones.correo, `${P}-migracion@ejemplo.com`));
		expect(filas).toEqual([{ id: sha256(id) }]);
		/* El navegador trae la cookie de antes: entra y pasa a la nueva. */
		const c = galletas();
		c.set('sd_sesion', id, { path: '/' });
		const leida = await sesion.leer(c);
		expect(leida?.correo).toBe(`${P}-migracion@ejemplo.com`);
		expect(c.get('sd_sesion')).toBeUndefined();
		expect(c.get(sesion.COOKIE_SESION)).toBe(id);
		expect(c.opciones.get(sesion.COOKIE_SESION)).toMatchObject({ secure: true, httpOnly: true });
		expect(await sesion.leer(c)).not.toBeNull();
	});
});
