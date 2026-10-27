/*
 * La recepción de eventos contra una base de datos de verdad (la de
 * desarrollo, DATABASE_URL de .env). Si no hay, la prueba se salta.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let hayBase = false;
try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
	hayBase = !!process.env.DATABASE_URL;
} catch {
	hayBase = false;
}
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { hashEvento, GENESIS } = await import('@sugardaddy/contrato');
const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { recibirEventos } = hayBase ? await import('./sensor') : ({} as never);
const { eq, inArray } = await import('drizzle-orm');

const SENSOR = 'zz-prueba-recepcion';
const OTRO = 'zz-prueba-otro';
const TRAMPA = 'zz-t1';
const AJENA = 'zz-t-ajena';

let n = 0;
function linea(anterior: string, cambios: Record<string, unknown> = {}) {
	n++;
	return JSON.stringify({
		version: 2,
		id: `2b0e0000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		cuando: new Date(Date.UTC(2026, 9, 15, 10, 0, n)).toISOString(),
		trampa: { id: TRAMPA, modulo: 'cowrie', tipo: 'contenedor' },
		sensor: SENSOR,
		origen: { ip: '203.0.113.7', usuario: 'root' },
		accion: 'conexion',
		severidad: 'media',
		conexionEstablecida: true,
		hashAnterior: anterior,
		...cambios
	});
}
function cadena(desde: string, k: number, cambios: Record<string, unknown>[] = []) {
	const lineas: string[] = [];
	let h = desde;
	for (let i = 0; i < k; i++) {
		const l = linea(h, cambios[i] ?? {});
		lineas.push(l);
		h = hashEvento(l);
	}
	return { lineas, ultimo: h };
}

async function limpiar() {
	for (const t of [s.eventos, s.cuarentena, s.rupturas])
		await db.delete(t).where(inArray(t.sensor, [SENSOR, OTRO]));
	await db.delete(s.trampas).where(inArray(s.trampas.id, [TRAMPA, AJENA]));
	await db.delete(s.auditoria).where(eq(s.auditoria.quien, `sensor ${SENSOR}`));
	await db.delete(s.sensores).where(inArray(s.sensores.id, [SENSOR, OTRO]));
}

const cuantos = async (t: typeof s.eventos | typeof s.cuarentena | typeof s.rupturas) =>
	(await db.select().from(t).where(eq(t.sensor, SENSOR))).length;

describe.skipIf(!hayBase)('recepción de eventos: nunca se queda parada', () => {
	beforeAll(async () => {
		await limpiar();
		for (const id of [SENSOR, OTRO])
			await db.insert(s.sensores).values({ id, nombre: id, claveHash: `x-${id}` });
		const comun = { modulo: 'cowrie', tipo: 'contenedor' as const, donde: '-', parametros: {} };
		await db.insert(s.trampas).values({ id: TRAMPA, nombre: 't1', sensor: SENSOR, ...comun });
		await db.insert(s.trampas).values({ id: AJENA, nombre: 'ajena', sensor: OTRO, ...comun });
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	let ultimo = GENESIS;

	it('guarda una cadena normal', async () => {
		const c = cadena(ultimo, 3);
		expect(await recibirEventos(SENSOR, c.lineas)).toEqual({
			ok: true,
			aceptadas: 3,
			ultimoHash: c.ultimo
		});
		expect(await cuantos(s.eventos)).toBe(3);
		ultimo = c.ultimo;
	});

	it('un reenvío de lo ya guardado cuenta como recibido y no mueve la cadena', async () => {
		const todas = (await db.select().from(s.eventos).where(eq(s.eventos.sensor, SENSOR))).map(
			(e) => e.linea
		);
		const r = await recibirEventos(SENSOR, todas);
		expect(r).toEqual({ ok: true, aceptadas: 3, ultimoHash: ultimo });
		expect(await cuantos(s.eventos)).toBe(3);
		expect(await cuantos(s.cuarentena)).toBe(0);
	});

	it('trampa retirada, de otro sensor, línea rota o fuera de contrato: a cuarentena, y sigue', async () => {
		const a = linea(ultimo, {
			trampa: { id: 'zz-retirada', modulo: 'cowrie', tipo: 'contenedor' }
		});
		const b = linea(hashEvento(a), { trampa: { id: AJENA, modulo: 'cowrie', tipo: 'contenedor' } });
		const c = '{esto no es json';
		const d = linea(hashEvento(c), { accion: 'inventada' });
		const e = linea(hashEvento(d));
		const r = await recibirEventos(SENSOR, [a, b, c, d, e]);
		expect(r).toEqual({ ok: true, aceptadas: 5, ultimoHash: hashEvento(e) });
		const q = await db.select().from(s.cuarentena).where(eq(s.cuarentena.sensor, SENSOR));
		expect(q.map((x) => x.motivo)).toEqual(
			expect.arrayContaining([
				'la trampa ya no existe (retirada)',
				'la trampa es de otro sensor',
				'no es JSON',
				expect.stringContaining('no cumple el contrato')
			])
		);
		expect(await cuantos(s.eventos)).toBe(4);
		expect(await cuantos(s.rupturas)).toBe(0);
		ultimo = hashEvento(e);
	});

	it('un evento ya recibido que vuelve con otros bytes va a cuarentena como repetido', async () => {
		const [primero] = await db
			.select()
			.from(s.eventos)
			.where(eq(s.eventos.sensor, SENSOR))
			.limit(1);
		const id = JSON.parse(primero.linea).id;
		const l = linea(ultimo, { id });
		const r = await recibirEventos(SENSOR, [l]);
		expect(r.ultimoHash).toBe(hashEvento(l));
		const [q] = await db
			.select()
			.from(s.cuarentena)
			.where(eq(s.cuarentena.hash, hashEvento(l)));
		expect(q.motivo).toBe('repite un evento ya recibido');
		ultimo = hashEvento(l);
	});

	it('una línea con bytes nulos (corte de luz) va a cuarentena sin tumbar la entrega', async () => {
		const sucia = '\u0000\u0000' + linea(ultimo);
		const sigue = linea(hashEvento(sucia));
		const r = await recibirEventos(SENSOR, [sucia, sigue]);
		expect(r).toEqual({ ok: true, aceptadas: 2, ultimoHash: hashEvento(sigue) });
		const [q] = await db
			.select()
			.from(s.cuarentena)
			.where(eq(s.cuarentena.hash, hashEvento(sucia)));
		expect(q.motivo).toBe('no es JSON');
		ultimo = hashEvento(sigue);
	});

	it('una cadena rota se anota y se sigue recibiendo', async () => {
		const c = cadena('f'.repeat(64), 2);
		const r = await recibirEventos(SENSOR, c.lineas);
		expect(r).toEqual({ ok: true, aceptadas: 2, ultimoHash: c.ultimo });
		const rot = await db.select().from(s.rupturas).where(eq(s.rupturas.sensor, SENSOR));
		expect(rot).toHaveLength(1);
		expect(rot[0]).toMatchObject({ esperado: ultimo, recibido: 'f'.repeat(64) });
		expect(await cuantos(s.eventos)).toBe(7);
	});
});
