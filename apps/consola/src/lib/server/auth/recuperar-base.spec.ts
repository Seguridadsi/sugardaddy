/*
 * «¿Has olvidado la contraseña?» contra una base de datos de verdad: pedir el
 * código, canjearlo, los frenos y lo que no se delata. El panel se sustituye
 * por un doble que se queda con el código. DATABASE_URL (del entorno o de
 * .env); si no hay, se salta. Todo lleva el prefijo zz-recup y se limpia.
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
process.env.LOGIN_LOCAL = '1';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const mandados: { correo: string; codigo: string }[] = [];
vi.mock('../canal', () => ({
	mandarCodigoPorCanal: async (correo: string, codigo: string) => {
		mandados.push({ correo, codigo });
		return true;
	},
	urlPanelValida: () => false
}));

const { db, schema: s } = hayBase ? await import('../db') : ({} as never);
const local = hayBase ? await import('./local') : ({} as never);
const rec = hayBase ? await import('./recuperar') : ({} as never);
const { and, eq, isNull, like } = await import('drizzle-orm');

const P = 'zz-recup';
const clave1 = 'contraseña muy larga uno';
const clave2 = 'otra contraseña larga dos';
let id = '';

async function limpiar() {
	await db.delete(s.usuariosLocales).where(like(s.usuariosLocales.usuario, `${P}%`));
}

/* Como si hubiera pasado el freno de un minuto: los códigos ya pedidos, más viejos. */
async function envejecer() {
	await db
		.update(s.recuperacionesClave)
		.set({ creada: new Date(Date.now() - 2 * 60_000) })
		.where(eq(s.recuperacionesClave.usuarioId, id));
}

async function pedir(usuario = `${P}-ana`) {
	const antes = mandados.length;
	await rec.pedirCodigo(usuario);
	/* El envío va aparte (para no delatar por el reloj): se espera un poco. */
	await new Promise((r) => setTimeout(r, 50));
	return mandados.length > antes ? mandados.at(-1)!.codigo : null;
}

describe.skipIf(!hayBase)('recuperar la contraseña con un código por correo', () => {
	beforeAll(async () => {
		await limpiar();
		const c = await local.crear('tester', {
			usuario: `${P}-ana`,
			nombre: 'Ana',
			correo: 'ana@ejemplo.com',
			roles: ['admin'],
			clave: clave1
		});
		id = c.ok ? c.id : '';
	});
	afterAll(async () => {
		if (!process.env.CONSERVAR) await limpiar();
	});
	beforeEach(() => {
		mandados.length = 0;
		rec._olvidarFrenos();
	});

	it('el hash del código: casa el bueno, no el malo ni otro formato', () => {
		const h = rec.hashCodigo('123456');
		expect(rec.codigoCorrecto('123456', h)).toBe(true);
		expect(rec.codigoCorrecto('123457', h)).toBe(false);
		expect(rec.codigoCorrecto('123456', 'scrypt$x$y')).toBe(false);
		expect(rec.hashCodigo('123456')).not.toBe(h); // con sal
	});

	it('a un usuario que no existe o sin correo no se le manda nada', async () => {
		expect(await pedir(`${P}-nadie`)).toBeNull();
		const c = await local.crear('tester', {
			usuario: `${P}-sincorreo`,
			nombre: '',
			correo: 'luego@ejemplo.com',
			roles: ['operador'],
			clave: clave1
		});
		await db
			.update(s.usuariosLocales)
			.set({ correo: 'admin@local' })
			.where(eq(s.usuariosLocales.id, c.ok ? c.id : ''));
		expect(await pedir(`${P}-sincorreo`)).toBeNull();
	});

	it('pide el código, va a su correo y al canjearlo cambia la contraseña', async () => {
		const codigo = await pedir(`  ${P.toUpperCase()}-ANA `);
		expect(codigo).toMatch(/^\d{6}$/);
		expect(mandados.at(-1)!.correo).toBe('ana@ejemplo.com');

		expect((await rec.canjearCodigo(`${P}-ana`, codigo!, 'corta')).ok).toBe(false);
		const r = await rec.canjearCodigo(
			`${P}-ana`,
			`${codigo!.slice(0, 3)} ${codigo!.slice(3)}`,
			clave2
		);
		expect(r.ok).toBe(true);
		expect((await local.verificar(`${P}-ana`, clave2)).ok).toBe(true);
		expect((await local.verificar(`${P}-ana`, clave1)).ok).toBe(false);

		/* Gastado: no vale dos veces. */
		expect((await rec.canjearCodigo(`${P}-ana`, codigo!, clave1)).ok).toBe(false);
	});

	it('como mucho uno por minuto, y pedir otro anula el anterior', async () => {
		await envejecer();
		const primero = await pedir();
		expect(primero).not.toBeNull();
		expect(await pedir()).toBeNull(); // antes del minuto: frenado
		await envejecer();
		const segundo = await pedir();
		expect(segundo).not.toBeNull();
		if (primero !== segundo)
			expect((await rec.canjearCodigo(`${P}-ana`, primero!, clave1)).ok).toBe(false);
		expect((await rec.canjearCodigo(`${P}-ana`, segundo!, clave1)).ok).toBe(true);
	});

	it('cinco fallos matan el código aunque luego llegue el bueno', async () => {
		await envejecer();
		const codigo = await pedir();
		const malo = codigo === '000000' ? '111111' : '000000';
		for (let i = 0; i < 5; i++)
			expect((await rec.canjearCodigo(`${P}-ana`, malo, clave2)).ok).toBe(false);
		expect((await rec.canjearCodigo(`${P}-ana`, codigo!, clave2)).ok).toBe(false);
	});

	it('en paralelo tampoco pasan de cinco intentos por código', async () => {
		await envejecer();
		const codigo = await pedir();
		const malo = codigo === '000000' ? '111111' : '000000';
		const r = await Promise.all(
			Array.from({ length: 30 }, () => rec.canjearCodigo(`${P}-ana`, malo, clave2))
		);
		expect(r.every((x) => !x.ok)).toBe(true);
		const [fila] = await db
			.select({ intentos: s.recuperacionesClave.intentos })
			.from(s.recuperacionesClave)
			.where(and(eq(s.recuperacionesClave.usuarioId, id), isNull(s.recuperacionesClave.cerrada)));
		expect(fila.intentos).toBe(5);
		expect((await rec.canjearCodigo(`${P}-ana`, codigo!, clave2)).ok).toBe(false);
	});

	it('desde una misma IP, diez canjes cada cuarto de hora', async () => {
		await envejecer();
		await pedir();
		for (let i = 0; i < 10; i++)
			expect(await rec.canjearCodigo(`${P}-nadie`, '123456', clave2, '203.0.113.9')).toEqual({
				ok: false,
				error: expect.not.stringMatching(/Too many/)
			});
		expect(await rec.canjearCodigo(`${P}-ana`, '123456', clave2, '203.0.113.9')).toEqual({
			ok: false,
			error: rec.DEMASIADOS
		});
		/* Otra IP sigue pudiendo. */
		expect(await rec.canjearCodigo(`${P}-nadie`, '123456', clave2, '203.0.113.10')).not.toEqual({
			ok: false,
			error: rec.DEMASIADOS
		});
	});

	it('diez códigos al día como mucho, aunque se espacien', async () => {
		await db.delete(s.recuperacionesClave).where(eq(s.recuperacionesClave.usuarioId, id));
		for (let i = 0; i < 10; i++) {
			expect(await pedir()).not.toBeNull();
			await db
				.update(s.recuperacionesClave)
				.set({ creada: new Date(Date.now() - 2 * 3600_000) })
				.where(eq(s.recuperacionesClave.usuarioId, id));
		}
		expect(await pedir()).toBeNull();
		await db.delete(s.recuperacionesClave).where(eq(s.recuperacionesClave.usuarioId, id));
	});

	it('un código caducado no vale', async () => {
		await envejecer();
		const codigo = await pedir();
		await db
			.update(s.recuperacionesClave)
			.set({ caduca: new Date(Date.now() - 1000) })
			.where(eq(s.recuperacionesClave.usuarioId, id));
		expect((await rec.canjearCodigo(`${P}-ana`, codigo!, clave2)).ok).toBe(false);
	});

	it('cinco por hora como mucho', async () => {
		await db.delete(s.recuperacionesClave).where(eq(s.recuperacionesClave.usuarioId, id));
		for (let i = 0; i < 5; i++) {
			expect(await pedir()).not.toBeNull();
			await envejecer();
		}
		expect(await pedir()).toBeNull();
	});
});
