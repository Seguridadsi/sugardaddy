/*
 * La recepción de eventos contra una base de datos de verdad (la de
 * desarrollo, DATABASE_URL de .env). Si no hay, la prueba se salta.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { borrarAuditoriaDePrueba } from './db/pruebas-auditoria';

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
const { recibirEventos, MOTIVO_DUPLICADO, MOTIVO_REPETIDO } = hayBase
	? await import('./sensor')
	: ({} as never);
const { eq, inArray, sql } = await import('drizzle-orm');

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
	await borrarAuditoriaDePrueba(db, eq(s.auditoria.quien, `sensor ${SENSOR}`));
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
				'the honeypot no longer exists (removed)',
				'the honeypot belongs to another sensor',
				'not JSON',
				expect.stringContaining('does not meet the contract')
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
		expect(q.motivo).toBe('repeats an event already received');
		/* Con otro contenido sí cuenta: puede ser una línea cambiada. */
		expect(q.duplicado).toBe(false);
		ultimo = hashEvento(l);
	});

	/*
	 * Los sensores de internet de KEBAPS (0.33.1), tras cada actualización: el sensor
	 * volvía a leer el registro de una trampa y mandaba el mismo evento encadenado en
	 * otro punto. Se guarda (es un eslabón), pero no es una anomalía.
	 */
	it('el mismo evento leído otra vez (solo cambia hashAnterior) es un duplicado: se guarda y no cuenta', async () => {
		const guardados = await db
			.select()
			.from(s.eventos)
			.where(eq(s.eventos.sensor, SENSOR))
			.orderBy(s.eventos.cuando);
		const eventosAntes = guardados.length;
		const rupturasAntes = await cuantos(s.rupturas);
		const otraVez = (fila: { linea: string }, anterior: string) =>
			JSON.stringify({ ...JSON.parse(fila.linea), hashAnterior: anterior });
		const a = otraVez(guardados[1], ultimo);
		const b = otraVez(guardados[2], hashEvento(a));
		const sigue = linea(hashEvento(b));
		const r = await recibirEventos(SENSOR, [a, b, sigue]);
		expect(r).toEqual({ ok: true, aceptadas: 3, ultimoHash: hashEvento(sigue) });
		const q = await db
			.select()
			.from(s.cuarentena)
			.where(inArray(s.cuarentena.hash, [hashEvento(a), hashEvento(b)]));
		expect(q).toHaveLength(2);
		for (const x of q) {
			expect(x).toMatchObject({ duplicado: true, motivo: MOTIVO_DUPLICADO });
			/* Con su eslabón, para verificar la cadena juntando eventos y cuarentena. */
			expect(x.hashAnterior).toBe(JSON.parse(x.linea).hashAnterior);
		}
		expect(await cuantos(s.eventos)).toBe(eventosAntes + 1);
		expect(await cuantos(s.rupturas)).toBe(rupturasAntes);
		ultimo = hashEvento(sigue);
	});

	it('un duplicado que además rompe la cadena deja la ruptura anotada', async () => {
		const [fila] = await db
			.select()
			.from(s.eventos)
			.where(eq(s.eventos.sensor, SENSOR))
			.orderBy(s.eventos.cuando)
			.limit(1);
		const rupturasAntes = await cuantos(s.rupturas);
		const l = JSON.stringify({ ...JSON.parse(fila.linea), hashAnterior: 'e'.repeat(64) });
		const r = await recibirEventos(SENSOR, [l]);
		expect(r.ultimoHash).toBe(hashEvento(l));
		const [q] = await db
			.select()
			.from(s.cuarentena)
			.where(eq(s.cuarentena.hash, hashEvento(l)));
		expect(q.duplicado).toBe(true);
		expect(await cuantos(s.rupturas)).toBe(rupturasAntes + 1);
		ultimo = hashEvento(l);
	});

	it('la migración 0072 pasa a duplicado lo que ya estaba apartado como repetido, sin borrar nada', async () => {
		const [fila] = await db
			.select()
			.from(s.eventos)
			.where(eq(s.eventos.sensor, SENSOR))
			.orderBy(s.eventos.cuando)
			.limit(1);
		const igual = JSON.stringify({ ...JSON.parse(fila.linea), hashAnterior: 'a'.repeat(64) });
		const distinto = JSON.stringify({
			...JSON.parse(fila.linea),
			hashAnterior: 'b'.repeat(64),
			severidad: 'critica'
		});
		const filas = [igual, distinto, '{roto'].map((l) => ({
			sensor: SENSOR,
			hash: hashEvento(l),
			hashAnterior: null,
			linea: l,
			motivo: MOTIVO_REPETIDO
		}));
		await db.insert(s.cuarentena).values(filas);
		const total = await cuantos(s.cuarentena);
		const migracion = readFileSync('drizzle/0072_cuarentena_duplicados.sql', 'utf8')
			.split('--> statement-breakpoint')
			.slice(1);
		await db.transaction(async (tx) => {
			for (const sentencia of migracion) await tx.execute(sql.raw(sentencia));
		});
		const q = await db
			.select()
			.from(s.cuarentena)
			.where(
				inArray(
					s.cuarentena.hash,
					filas.map((f) => f.hash)
				)
			);
		const por = new Map(q.map((x) => [x.linea, x]));
		expect(por.get(igual)).toMatchObject({ duplicado: true, motivo: MOTIVO_DUPLICADO });
		expect(por.get(distinto)).toMatchObject({ duplicado: false, motivo: MOTIVO_REPETIDO });
		expect(por.get('{roto')).toMatchObject({ duplicado: false, motivo: MOTIVO_REPETIDO });
		expect(await cuantos(s.cuarentena)).toBe(total);
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
		expect(q.motivo).toBe('not JSON');
		ultimo = hashEvento(sigue);
	});

	it('una cadena rota se anota y se sigue recibiendo', async () => {
		const c = cadena('f'.repeat(64), 2);
		const r = await recibirEventos(SENSOR, c.lineas);
		expect(r).toEqual({ ok: true, aceptadas: 2, ultimoHash: c.ultimo });
		const rot = (await db.select().from(s.rupturas).where(eq(s.rupturas.sensor, SENSOR))).filter(
			(x) => x.recibido === 'f'.repeat(64)
		);
		expect(rot).toHaveLength(1);
		expect(rot[0]).toMatchObject({ esperado: ultimo, recibido: 'f'.repeat(64) });
		expect(await cuantos(s.eventos)).toBe(8);
	});
});
