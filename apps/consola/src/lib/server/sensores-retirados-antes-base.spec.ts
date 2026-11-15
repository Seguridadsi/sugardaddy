/*
 * La migración 0056: los sensores quitados antes de que existiera «retirado»
 * (solo se les cortaba el token) quedan marcados como retirados, y así su
 * identificador se puede volver a dar de alta. Uno que latió después de
 * quitarlo lo volvieron a instalar: sigue en uso y no se toca.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { borrarAuditoriaDePrueba } from './db/pruebas-auditoria';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL)('sensores quitados antes de la 0.29', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, like, sql } = await import('drizzle-orm');
	const MIGRACION = readFileSync(
		join(process.cwd(), 'drizzle/0056_sensores_retirados_antes.sql'),
		'utf8'
	);

	const P = 'zz-retiradoantes';
	const QUIEN = `${P}@prueba`;
	const HORA = 3_600_000;
	const quitadoHace = Date.now() - 2 * HORA;

	const limpiar = async () => {
		await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
		await borrarAuditoriaDePrueba(db, eq(s.auditoria.quien, QUIEN));
	};
	const alta = (id: string, remoto: boolean, latido: number | null) =>
		db.insert(s.sensores).values({
			id,
			nombre: id,
			claveHash: 'x'.repeat(64),
			remoto,
			ultimoLatido: latido === null ? null : new Date(latido)
		});
	const quitado = (id: string) =>
		db.insert(s.auditoria).values({
			quien: QUIEN,
			accion: 'sensor deactivated',
			detalle: { id },
			cuando: new Date(quitadoHace)
		});
	const retirado = async (id: string) =>
		(await db.select().from(s.sensores).where(eq(s.sensores.id, id)))[0]?.retirado ?? null;

	beforeEach(limpiar);
	afterAll(limpiar);

	it('uno quitado que no volvió a latir queda retirado, con la fecha en que se quitó', async () => {
		await alta(`${P}-a`, true, quitadoHace - HORA);
		await quitado(`${P}-a`);
		await db.execute(sql.raw(MIGRACION));
		expect((await retirado(`${P}-a`))?.getTime()).toBe(quitadoHace);
	});

	it('uno que latió después de quitarlo sigue en uso', async () => {
		await alta(`${P}-b`, true, Date.now());
		await quitado(`${P}-b`);
		await db.execute(sql.raw(MIGRACION));
		expect(await retirado(`${P}-b`)).toBeNull();
	});

	it('no toca los que nunca se quitaron ni el sensor de la propia máquina', async () => {
		await alta(`${P}-c`, true, quitadoHace - HORA);
		await alta(`${P}-d`, false, quitadoHace - HORA);
		await quitado(`${P}-d`);
		await db.execute(sql.raw(MIGRACION));
		expect(await retirado(`${P}-c`)).toBeNull();
		expect(await retirado(`${P}-d`)).toBeNull();
	});

	it('se puede pasar dos veces sin cambiar nada', async () => {
		await alta(`${P}-e`, true, null);
		await quitado(`${P}-e`);
		await db.execute(sql.raw(MIGRACION));
		const primera = await retirado(`${P}-e`);
		await db.execute(sql.raw(MIGRACION));
		expect(await retirado(`${P}-e`)).toEqual(primera);
	});
});
