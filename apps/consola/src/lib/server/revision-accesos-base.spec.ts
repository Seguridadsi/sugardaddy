/*
 * La revisión de accesos contra una base de verdad: la entrada apunta la cuenta,
 * una desactivada no entra, la inactividad la desactiva (y cierra sus sesiones),
 * reactivar y confirmar la revisión. DATABASE_URL (del entorno o de .env); si no
 * hay, se salta. Todo lleva el prefijo zz-revision y se limpia al final.
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

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const r = hayBase ? await import('./revision-accesos') : ({} as never);
const { and, eq, like, isNull } = await import('drizzle-orm');

const P = 'zz-revision';
const ident = (n: string, roles: ('lector' | 'admin')[] = ['lector']) => ({
	oid: `${P}:${n}`,
	correo: `${n}@${P}.example`,
	nombre: n,
	roles,
	soporte: false
});

async function limpiar() {
	await db.delete(s.usuariosAcceso).where(like(s.usuariosAcceso.oid, `${P}%`));
	await db.delete(s.sesiones).where(like(s.sesiones.oid, `${P}%`));
	await db.delete(s.revisionesAcceso).where(like(s.revisionesAcceso.quien, `${P}%`));
}

describe.skipIf(!hayBase)('revisión de accesos contra base de datos', () => {
	beforeAll(limpiar);
	afterAll(async () => {
		if (!process.env.CONSERVAR) await limpiar();
	});

	it('la entrada apunta la cuenta; el soporte y la emergencia no', async () => {
		expect(await r.apuntarEntrada(ident('ana'))).toBe(true);
		expect(await r.apuntarEntrada({ ...ident('sop'), soporte: true })).toBe(true);
		const filas = await db
			.select()
			.from(s.usuariosAcceso)
			.where(like(s.usuariosAcceso.oid, `${P}%`));
		expect(filas.map((f) => f.oid)).toEqual([`${P}:ana`]);
		expect(filas[0].ultimaEntrada).not.toBeNull();
	});

	it('la inactividad desactiva, cierra las sesiones y la cuenta ya no entra', async () => {
		const viejo = new Date(Date.now() - 400 * 86_400_000);
		await db.insert(s.usuariosAcceso).values({
			oid: `${P}:luis`,
			correo: `luis@${P}.example`,
			nombre: 'luis',
			roles: ['lector'],
			visto: viejo,
			ultimaEntrada: viejo
		});
		await db.insert(s.sesiones).values({
			id: `${P}-sesion-luis`,
			oid: `${P}:luis`,
			correo: `luis@${P}.example`,
			nombre: 'luis',
			roles: ['lector']
		});
		expect(await r.desactivarInactivas()).toBeGreaterThanOrEqual(1);
		const [f] = await db
			.select()
			.from(s.usuariosAcceso)
			.where(eq(s.usuariosAcceso.oid, `${P}:luis`));
		expect(f.desactivada).not.toBeNull();
		expect(f.motivo).toBe('inactividad');
		const abiertas = await db
			.select()
			.from(s.sesiones)
			.where(and(eq(s.sesiones.oid, `${P}:luis`), isNull(s.sesiones.cerrada)));
		expect(abiertas).toHaveLength(0);
		expect(await r.apuntarEntrada(ident('luis'))).toBe(false);
		/* Ana entró hace nada: sigue activa. */
		const [ana] = await db
			.select()
			.from(s.usuariosAcceso)
			.where(eq(s.usuariosAcceso.oid, `${P}:ana`));
		expect(ana.desactivada).toBeNull();
	});

	it('reactivar deja entrar otra vez y no vuelve a caer a la hora siguiente', async () => {
		expect((await r.reactivar(`${P}-admin`, `${P}:luis`)).ok).toBe(true);
		await r.desactivarInactivas();
		expect(await r.apuntarEntrada(ident('luis'))).toBe(true);
		expect((await r.reactivar(`${P}-admin`, `${P}:luis`)).ok).toBe(false);
	});

	it('desactivar a mano y confirmar la revisión', async () => {
		expect((await r.desactivar(`${P}-admin`, `${P}:ana`)).ok).toBe(true);
		expect((await r.desactivar(`${P}-admin`, `${P}:ana`)).ok).toBe(false);
		await r.confirmarRevision(`${P}-admin`, '  ticket 42  ');
		const [rev] = await db
			.select()
			.from(s.revisionesAcceso)
			.where(eq(s.revisionesAcceso.quien, `${P}-admin`));
		expect(rev.nota).toBe('ticket 42');
		expect(rev.usuarios.find((u) => u.oid === `${P}:ana`)?.activa).toBe(false);
		const e = await r.estadoRevision();
		expect(e.vencida).toBe(false);
	});
});
