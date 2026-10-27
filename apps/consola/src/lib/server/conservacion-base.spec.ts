/*
 * El borrado por plazo de conservación contra una base de datos de verdad.
 * DATABASE_URL (del entorno o de .env); si no hay, se salta. Todo lo de esta
 * prueba es de 2020 o lleva zz-cons: el borrado va hasta junio de 2020, así
 * que en una base de desarrollo no toca nada más.
 *
 * Un sensor con dos entregas viejas (eventos y una línea en cuarentena) y una
 * reciente. Las viejas se van con lo que cuelga de ellas; la reciente se
 * queda, y la cadena sigue justo desde el hash que apunta el borrado.
 */
import { randomUUID } from 'node:crypto';
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
const { borrarAntesDe, borrarAuditoriaAntesDe } = hayBase
	? await import('./conservacion')
	: ({} as never);
const { eq, like } = await import('drizzle-orm');

const P = 'zz-cons';
const S = `${P}-s1`;
const h = (n: number) => String(n).repeat(64).slice(0, 64);
const GENESIS = '0'.repeat(64);
const viejaA = new Date('2020-01-10T10:00:00Z');
const viejaB = new Date('2020-03-01T10:00:00Z');
const reciente = new Date('2026-10-20T10:00:00Z');
const ids = { e1: randomUUID(), e2: randomUUID(), e3: randomUUID(), e5: randomUUID() };

const evento = (id: string, hash: string, anterior: string, recibido: Date) => ({
	id,
	sensor: S,
	linea: JSON.stringify({ hashAnterior: anterior }),
	hash,
	cuando: recibido,
	trampa: `${P}-t1`,
	modulo: 'cowrie',
	tipo: 'contenedor',
	accion: 'login',
	severidad: 'media' as const,
	conexionEstablecida: true,
	recibido
});

async function limpiar() {
	await db.delete(s.auditoria).where(like(s.auditoria.quien, `${P}%`));
	await db.delete(s.activaciones).where(like(s.activaciones.trampa, `${P}%`));
	for (const t of [s.eventos, s.cuarentena]) await db.delete(t).where(like(t.sensor, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
}

describe.skipIf(!hayBase)('la consola borra los eventos que pasan del plazo', () => {
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: S, nombre: S, claveHash: h(9) });
		/* Entrega A: e1 → e2. Entrega B: e3 → q4 (en cuarentena). Reciente: e5. */
		await db
			.insert(s.eventos)
			.values([
				evento(ids.e1, h(1), GENESIS, viejaA),
				evento(ids.e2, h(2), h(1), viejaA),
				evento(ids.e3, h(3), h(2), viejaB),
				evento(ids.e5, h(5), h(4), reciente)
			]);
		await db.insert(s.cuarentena).values({
			sensor: S,
			hash: h(4),
			hashAnterior: h(3),
			linea: '{"roto":',
			motivo: 'no es JSON',
			recibido: viejaB
		});
		await db.insert(s.activaciones).values({ evento: ids.e1, trampa: `${P}-t2`, recibido: viejaA });
	});
	afterAll(async () => {
		if (!process.env.CONSERVAR) await limpiar();
	});

	it('borra las entregas viejas, con su cuarentena y sus activaciones', async () => {
		const r = await borrarAntesDe(new Date('2020-06-01T00:00:00Z'));
		expect(r.eventos).toBeGreaterThanOrEqual(3);
		expect(r.cuarentena).toBeGreaterThanOrEqual(1);

		const quedan = await db
			.select({ id: s.eventos.id })
			.from(s.eventos)
			.where(eq(s.eventos.sensor, S));
		expect(quedan.map((q) => q.id)).toEqual([ids.e5]);
		expect(await db.select().from(s.cuarentena).where(eq(s.cuarentena.sensor, S))).toEqual([]);
		expect(
			await db
				.select()
				.from(s.activaciones)
				.where(like(s.activaciones.trampa, `${P}%`))
		).toEqual([]);

		/* La cadena sigue desde la última línea borrada, que estaba en cuarentena. */
		expect(r.cadena[S]).toEqual([h(4)]);
	});

	it('la auditoría vieja se va; la reciente se queda', async () => {
		await db.insert(s.auditoria).values([
			{ quien: `${P}-vieja`, accion: 'zz', cuando: viejaA },
			{ quien: `${P}-reciente`, accion: 'zz', cuando: reciente }
		]);
		expect(await borrarAuditoriaAntesDe(new Date('2020-06-01T00:00:00Z'))).toBeGreaterThanOrEqual(
			1
		);
		const quedan = await db
			.select({ quien: s.auditoria.quien })
			.from(s.auditoria)
			.where(like(s.auditoria.quien, `${P}%`));
		expect(quedan.map((q) => q.quien)).toEqual([`${P}-reciente`]);
	});

	it('sin nada viejo, no borra nada', async () => {
		const r = await borrarAntesDe(new Date('2020-06-01T00:00:00Z'));
		expect(r.cadena[S]).toBeUndefined();
	});
});
