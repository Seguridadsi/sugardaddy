/* La métrica de ruido contra Postgres: qué cuenta como evento, como escáner y como falso positivo. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL)('el ruido por honeypot', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, like } = await import('drizzle-orm');
	const { ruidoPorTrampa } = await import('./ruido');

	const P = 'zz-ruido';
	const SENSOR = `${P}-sensor`;
	const T1 = `${P}-ssh`;
	const T2 = `${P}-callada`;

	const limpiar = async () => {
		await db.delete(s.eventos).where(eq(s.eventos.sensor, SENSOR));
		await db.delete(s.trampas).where(like(s.trampas.id, `${P}%`));
		await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
	};

	let n = 0;
	const evento = (extra: { escaner?: string; prueba?: boolean; recibido?: Date } = {}) => {
		const id = randomUUID();
		const cuando = extra.recibido ?? new Date();
		return {
			id,
			sensor: SENSOR,
			linea: JSON.stringify({ id }),
			hash: `${SENSOR}-${n++}`,
			cuando,
			recibido: cuando,
			trampa: T1,
			modulo: 'cowrie',
			tipo: 'contenedor',
			accion: 'conexion',
			severidad: 'baja' as const,
			ip: '203.0.113.9',
			conexionEstablecida: true,
			prueba: extra.prueba ?? false,
			escaner: extra.escaner ?? null
		};
	};

	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		for (const id of [T1, T2])
			await db.insert(s.trampas).values({
				id,
				nombre: id,
				modulo: 'cowrie',
				tipo: 'contenedor',
				sensor: SENSOR,
				donde: 'zz'
			});
		const normal = evento();
		const falso = evento();
		const interesante = evento();
		const deEscaner = evento({ escaner: 'google' });
		/* Un escáner que además alguien marcó como falso positivo: cuenta una vez, como escáner. */
		const escanerMarcado = evento({ escaner: 'google' });
		await db.insert(s.eventos).values([
			normal,
			falso,
			interesante,
			deEscaner,
			escanerMarcado,
			/* Ni las pruebas ni lo de hace más de 30 días entran. */
			evento({ prueba: true }),
			evento({ recibido: new Date(Date.now() - 40 * 86_400_000) })
		]);
		await db.insert(s.triaje).values([
			{ evento: falso.id, estado: 'falso-positivo', quien: 'zz' },
			{ evento: interesante.id, estado: 'interesante', quien: 'zz' },
			{ evento: escanerMarcado.id, estado: 'falso-positivo', quien: 'zz' }
		]);
	});
	afterAll(limpiar);

	it('cuenta eventos, escáneres, falsos positivos y confirmados, sin pruebas ni lo antiguo', async () => {
		const filas = await ruidoPorTrampa();
		expect(filas.find((f) => f.id === T1)).toEqual({
			id: T1,
			nombre: T1,
			modulo: 'cowrie',
			eventos: 5,
			escaner: 2,
			falsosPositivos: 1,
			confirmados: 1
		});
	});

	it('un honeypot sin eventos sale con todo a cero', async () => {
		expect((await ruidoPorTrampa()).find((f) => f.id === T2)).toMatchObject({
			eventos: 0,
			escaner: 0,
			falsosPositivos: 0,
			confirmados: 0
		});
	});
});
