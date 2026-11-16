/*
 * El segundo factor contra una base de datos de verdad: alta durante la
 * entrada, códigos que no valen dos veces, códigos de recuperación, el tope de
 * intentos, quitar con la exigencia puesta, el restablecimiento del
 * administrador y la sesión con su factor. (Que esos textos salen al SIEM
 * como auditoria.mfa lo fija salidas-auditoria.spec.ts.) DATABASE_URL (del entorno o de
 * .env); si no hay, se salta. Todo lleva el prefijo zz-2fa y se limpia.
 */
import { readFileSync } from 'node:fs';
import type { Cookies } from '@sveltejs/kit';
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
const local = hayBase ? await import('./local') : ({} as never);
const sf = hayBase ? await import('./segundo-factor') : ({} as never);
const totp = await import('./totp');
const { and, eq, like, sql } = await import('drizzle-orm');

const P = 'zz-2fa';
const CLAVE = 'una contraseña bastante larga';

function galletas() {
	const m = new Map<string, string>();
	return {
		get: (k: string) => m.get(k),
		set: (k: string, v: string) => void m.set(k, v),
		delete: (k: string) => void m.delete(k),
		getAll: () => [...m].map(([name, value]) => ({ name, value })),
		serialize: () => ''
	} as unknown as Cookies;
}

async function limpiar() {
	await db.delete(s.usuariosLocales).where(like(s.usuariosLocales.usuario, `${P}%`));
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'segundo_factor'));
}

async function nuevo(nombre: string, roles = ['operador']) {
	const r = await local.crear('tester', {
		usuario: `${P}-${nombre}`,
		nombre,
		correo: `${nombre}@ejemplo.com`,
		roles,
		clave: CLAVE
	});
	if (!r.ok) throw new Error(r.error);
	const v = await local.verificar(`${P}-${nombre}`, CLAVE);
	if (!v.ok) throw new Error('no entra');
	return v;
}

const secretoDe = async (usuarioId: string) => {
	const [f] = await db
		.select()
		.from(s.factoresUsuario)
		.where(and(eq(s.factoresUsuario.usuarioId, usuarioId), eq(s.factoresUsuario.tipo, 'totp')));
	return f;
};

describe.skipIf(!hayBase)('segundo factor contra base de datos', () => {
	beforeAll(limpiar);
	afterAll(async () => {
		if (!process.env.CONSERVAR) await limpiar();
	});

	let ana: Awaited<ReturnType<typeof nuevo>>;
	let secreto = '';
	let codigos: string[] = [];
	const t0 = Date.parse('2026-11-15T10:00:00Z');

	it('exigido de serie: sin factor, toca darlo de alta antes de la sesión', async () => {
		expect(await sf.exigido()).toBe(true);
		ana = await nuevo('ana');
		expect(await sf.queToca(ana.id)).toBe('alta');
		const c = galletas();
		expect(await sf.despuesDeLaClave(c, ana.id, ana.identidad, '/events')).toBe(
			'/sign-in/second-factor'
		);
		const p = sf.leerPaso(c)!;
		expect(p.modo).toBe('alta');
		/* Ninguna sesión todavía. */
		const [n] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(s.sesiones)
			.where(eq(s.sesiones.oid, `local:${ana.id}`));
		expect(n.n).toBe(0);

		secreto = sf.secretoAlta(p);
		expect(sf.secretoAlta(p)).toBe(secreto);
		expect((await sf.altaEnPasoTotp(p, '000000', 'Móvil')).ok).toBe(false);
		const bien = totp.codigo(totp.desdeBase32(secreto)!, totp.pasoDe(Date.now()));
		const r = await sf.altaEnPasoTotp(p, bien, 'Móvil');
		expect(r.ok).toBe(true);
		codigos = r.ok ? r.codigos : [];
		expect(codigos).toHaveLength(10);
		expect(codigos[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
		expect(p.hecho).toBe('totp');

		/* El secreto va cifrado, no en claro. */
		const f = await secretoDe(ana.id);
		expect(f.secreto).not.toContain(secreto);
		expect(f.nombre).toBe('Móvil');

		/* Era una contraseña de un solo uso: antes de la sesión, el cambio, con el factor apuntado. */
		const ir = await sf.despuesDelFactor(c, ana.id, ana.identidad, p.volverA, 'totp');
		expect(ir).toBe('/sign-in/change?volverA=%2Fevents');
		expect(local.factorRetoCambio(c.get(local.COOKIE_CAMBIO))).toBe('totp');
	});

	it('con factor: el código vale una vez y el siguiente intervalo sí', async () => {
		expect(await sf.queToca(ana.id)).toBe('verificar');
		await sf.fijarExigido('tester', false);
		/* Quien ya lo tiene lo usa siempre, esté exigido o no. */
		expect(await sf.queToca(ana.id)).toBe('verificar');
		await sf.fijarExigido('tester', true);

		const c = galletas();
		await sf.despuesDeLaClave(c, ana.id, ana.identidad, '/');
		const p = sf.leerPaso(c)!;
		const b = totp.desdeBase32(secreto)!;
		const ahora = t0 + 10 * 365 * 86_400_000;
		const r1 = await sf.verificarCodigo(c, p, totp.codigo(b, totp.pasoDe(ahora)), ahora);
		expect(r1).toEqual({ ok: true, factor: 'totp' });
		/* El mismo código otra vez (o uno anterior): no. */
		const r2 = await sf.verificarCodigo(c, p, totp.codigo(b, totp.pasoDe(ahora)), ahora);
		expect(r2.ok).toBe(false);
		const r3 = await sf.verificarCodigo(c, p, totp.codigo(b, totp.pasoDe(ahora) + 1), ahora);
		expect(r3.ok).toBe(true);
	});

	it('códigos de recuperación: cada uno una vez, y quedan en la auditoría', async () => {
		const c = galletas();
		await sf.despuesDeLaClave(c, ana.id, ana.identidad, '/');
		const p = sf.leerPaso(c)!;
		const r = await sf.verificarRecuperacion(c, p, codigos[0].toLowerCase().replace('-', ' '));
		expect(r).toEqual({ ok: true, factor: 'recuperacion', quedan: 9 });
		expect((await sf.verificarRecuperacion(c, p, codigos[0])).ok).toBe(false);
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.accion, 'two-factor recovery code used'))
			.orderBy(sql`${s.auditoria.id} desc`)
			.limit(1);
		expect(a.detalle).toMatchObject({ usuario: `${P}-ana`, quedan: 9 });
	});

	it('cinco fallos acaban el paso y bloquean al usuario (también para la contraseña)', async () => {
		const c = galletas();
		await sf.despuesDeLaClave(c, ana.id, ana.identidad, '/');
		const p = sf.leerPaso(c)!;
		let ultimo;
		for (let i = 0; i < sf.INTENTOS_POR_PASO; i++)
			ultimo = await sf.verificarCodigo(c, p, '000000');
		expect(ultimo).toMatchObject({ ok: false, fin: true });
		expect(sf.leerPaso(c)).toBeNull();
		expect((await local.verificar(`${P}-ana`, CLAVE)).ok).toBe(false);

		/* Pasado el bloqueo, un acierto deja el contador a cero. */
		await db
			.update(s.usuariosLocales)
			.set({ bloqueadoHasta: null })
			.where(eq(s.usuariosLocales.id, ana.id));
		const c2 = galletas();
		await sf.despuesDeLaClave(c2, ana.id, ana.identidad, '/');
		expect((await sf.verificarRecuperacion(c2, sf.leerPaso(c2)!, codigos[1])).ok).toBe(true);
		const [u] = await db
			.select({ n: s.usuariosLocales.intentosFallidos })
			.from(s.usuariosLocales)
			.where(eq(s.usuariosLocales.id, ana.id));
		expect(u.n).toBe(0);
	});

	it('quitar el último factor: no mientras se exija; sin él, también fuera los códigos', async () => {
		const [f] = await sf.factores(ana.id);
		expect((await sf.quitarFactor('ana', ana.id, f.id, 'mala')).ok).toBe(false);
		const r = await sf.quitarFactor('ana', ana.id, f.id, CLAVE);
		expect(r.ok).toBe(false);
		await sf.fijarExigido('tester', false);
		expect((await sf.quitarFactor('ana', ana.id, f.id, CLAVE)).ok).toBe(true);
		expect(await sf.codigosRestantes(ana.id)).toBe(0);
		expect(await sf.queToca(ana.id)).toBeNull();
		await sf.fijarExigido('tester', true);
	});

	it('el administrador restablece el de otro (no el suyo) y le cierra las sesiones', async () => {
		const bea = await nuevo('bea', ['admin']);
		const altaBea = await sf.altaTotp(
			'bea',
			bea.id,
			secreto,
			totp.codigo(totp.desdeBase32(secreto)!, totp.pasoDe(Date.now())),
			''
		);
		expect(altaBea.ok).toBe(true);
		await sf.nuevosCodigos('bea', bea.id);
		const c = galletas();
		await sf.entrar(c, bea.identidad, 'totp');
		const [ses] = await db
			.select()
			.from(s.sesiones)
			.where(eq(s.sesiones.oid, `local:${bea.id}`));
		expect(ses.factor).toBe('totp');

		expect((await sf.restablecerSegundoFactor('bea', `local:${bea.id}`, bea.id)).ok).toBe(false);
		expect((await sf.restablecerSegundoFactor('admin', 'local:otro', bea.id)).ok).toBe(true);
		expect(await sf.factores(bea.id)).toHaveLength(0);
		expect(await sf.codigosRestantes(bea.id)).toBe(0);
		const [cerrada] = await db.select().from(s.sesiones).where(eq(s.sesiones.id, ses.id));
		expect(cerrada.cerrada).not.toBeNull();
		expect(await sf.queToca(bea.id)).toBe('alta');
	});

	it('retirar al usuario se lleva sus factores', async () => {
		const [u] = await db
			.select()
			.from(s.usuariosLocales)
			.where(eq(s.usuariosLocales.usuario, `${P}-ana`));
		await sf.altaTotp(
			'ana',
			u.id,
			secreto,
			totp.codigo(totp.desdeBase32(secreto)!, totp.pasoDe(Date.now())),
			''
		);
		expect((await local.retirar('admin', u.id)).ok).toBe(true);
		expect(await sf.factores(u.id)).toHaveLength(0);
	});
});
