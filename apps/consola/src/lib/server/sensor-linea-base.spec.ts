/*
 * C01: una línea cuyo proceso hace fallar a Postgres no puede tumbar la entrega
 * entera (guardarEntrega, sensor.ts). Cada línea va en su punto de guardado: la
 * que falla va a la cuarentena con su motivo y las demás se guardan. Contra una
 * base de verdad (DATABASE_URL de .env); si no hay, se salta.
 *
 * Para provocar el fallo sin depender de un hueco concreto, pruebasDe lanza para
 * un token: lo que haya hecho la línea se deshace y va a la cuarentena.
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
	hayBase = !!process.env.DATABASE_URL;
}
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));
const VENENO = 'zz-veneno';
vi.mock('./pruebas', async (original) => {
	const o = await original<typeof import('./pruebas')>();
	return {
		...o,
		pruebasDe: (...a: Parameters<typeof o.pruebasDe>) => {
			if (a[0].detalle?.token === VENENO) throw new Error('poisoned line');
			return o.pruebasDe(...a);
		}
	};
});

const P = 'zz-linea';
const SENSOR = `${P}-sensor`;
const DESTINO = `${P}-nodo`;
const RECEPTOR = `${P}-receptor`;

describe.skipIf(!hayBase)(
	'guardarEntrega: una línea que falla no tumba el lote (C01)',
	async () => {
		const { db, schema: s } = await import('./db');
		const { eq, like } = await import('drizzle-orm');
		const { GENESIS, hashEvento } = await import('@sugardaddy/contrato');
		const { recibirEventos } = await import('./sensor');

		const limpiar = async () => {
			for (const t of [s.eventos, s.cuarentena, s.rupturas])
				await db.delete(t).where(like(t.sensor, `${P}%`));
			await db.delete(s.trampas).where(like(s.trampas.id, `${P}%`));
			await db.delete(s.destinos).where(like(s.destinos.id, `${P}%`));
			await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
		};
		beforeAll(async () => {
			await limpiar();
			await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
			await db
				.insert(s.destinos)
				.values({ id: DESTINO, nombre: 'Nodo', tipo: 'maquina', sensor: SENSOR });
			await db.insert(s.trampas).values({
				id: RECEPTOR,
				nombre: 'Receptor',
				modulo: 'receptor-balizas',
				tipo: 'contenedor',
				sensor: SENSOR,
				destino: DESTINO,
				donde: ':9000',
				parametros: { puertoBaliza: 9000 },
				colocacion: 'comprobada',
				comprobada: new Date()
			});
		});
		afterAll(async () => {
			if (!process.env.CONSERVAR) await limpiar();
		});

		let n = 0;
		const linea = (anterior: string, token: string) =>
			JSON.stringify({
				version: 2,
				id: `c01c01c0-0000-4000-8000-${String(++n).padStart(12, '0')}`,
				cuando: new Date(Date.UTC(2026, 10, 14, 9, 0, n)).toISOString(),
				trampa: { id: RECEPTOR, modulo: 'receptor-balizas', tipo: 'contenedor' },
				sensor: SENSOR,
				origen: { ip: '198.51.100.7' },
				accion: 'baliza',
				severidad: 'media',
				conexionEstablecida: true,
				detalle: { token, path: `/b/${token}` },
				hashAnterior: anterior
			});

		it('la línea que falla va a la cuarentena y las de antes y después se guardan', async () => {
			const antes = linea(GENESIS, 'zz-nada-1');
			const veneno = linea(hashEvento(antes), VENENO);
			const despues = linea(hashEvento(veneno), 'zz-nada-2');
			const r = await recibirEventos(SENSOR, [antes, veneno, despues]);
			expect(r).toMatchObject({ ok: true, aceptadas: 3, ultimoHash: hashEvento(despues) });

			for (const l of [antes, despues]) {
				const [ev] = await db
					.select()
					.from(s.eventos)
					.where(eq(s.eventos.id, JSON.parse(l).id));
				expect(ev).toBeTruthy();
			}
			expect(
				await db
					.select()
					.from(s.eventos)
					.where(eq(s.eventos.id, JSON.parse(veneno).id))
			).toHaveLength(0);
			const [c] = await db
				.select()
				.from(s.cuarentena)
				.where(eq(s.cuarentena.hash, hashEvento(veneno)));
			expect(c.motivo).toMatch(/^could not be processed: /);
			expect(c.linea).toBe(veneno);
			/* La cadena sigue: el sensor avanza y no ve ninguna ruptura. */
			const [f] = await db.select().from(s.sensores).where(eq(s.sensores.id, SENSOR));
			expect(f.ultimoHash).toBe(hashEvento(despues));
			expect(await db.select().from(s.rupturas).where(eq(s.rupturas.sensor, SENSOR))).toHaveLength(
				0
			);
		});

		it('una línea que falla sola en su lote también va a la cuarentena, sin error', async () => {
			const [c0] = await db.select().from(s.cuarentena).where(eq(s.cuarentena.sensor, SENSOR));
			expect(c0).toBeTruthy();
			const total = async () =>
				(await db.select().from(s.eventos).where(eq(s.eventos.sensor, SENSOR))).length +
				(await db.select().from(s.cuarentena).where(eq(s.cuarentena.sensor, SENSOR))).length;
			const antes = await total();
			const v = linea(GENESIS, VENENO);
			/* Una línea nueva que falla sola en su lote tampoco da un error: entra en cuarentena. */
			const [f] = await db.select().from(s.sensores).where(eq(s.sensores.id, SENSOR));
			const sola = JSON.stringify({ ...JSON.parse(v), hashAnterior: f.ultimoHash });
			const r = await recibirEventos(SENSOR, [sola]);
			expect(r.ok).toBe(true);
			expect(await total()).toBe(antes + 1);
		});
	}
);

describe.skipIf(!hayBase)('MapaConDeshacer', async () => {
	const { MapaConDeshacer } = await import('./sensor');
	it('deshace lo cambiado mientras estaba abierto y deja lo de antes', () => {
		const m = new MapaConDeshacer<string, number>([
			['a', 1],
			['b', 2]
		]);
		m.abrir();
		m.set('a', 10);
		m.set('c', 3);
		m.delete('b');
		m.set('a', 11);
		m.deshacer();
		expect([...m.entries()]).toEqual([
			['a', 1],
			['b', 2]
		]);
		m.abrir();
		m.set('a', 5);
		m.cerrar();
		m.set('b', 6);
		m.deshacer();
		expect(m.get('a')).toBe(5);
		expect(m.get('b')).toBe(6);
	});
});
