/*
 * Una trampa fuera del plan queda en espera, contra una base de datos de
 * verdad (la de desarrollo, DATABASE_URL de .env), con el catálogo de verdad.
 * Si no hay base, la prueba se salta.
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
vi.mock('./catalogo', async (original) => ({
	...(await original<typeof import('./catalogo')>()),
	autorizados: async () => ['cowrie']
}));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { plan, informarEstado } = hayBase ? await import('./sensor') : ({} as never);
const { trampasConEventos } = hayBase ? await import('./consultas') : ({} as never);
const { enEspera } = await import('../espera');
const { eq } = await import('drizzle-orm');

const SENSOR = 'zz-prueba-espera';
const TRAMPA = 'zz-espera-ssh';

async function limpiar() {
	await db.delete(s.trampas).where(eq(s.trampas.sensor, SENSOR));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
}
const donde = async () =>
	(await db.select().from(s.trampas).where(eq(s.trampas.id, TRAMPA)))[0].donde;

describe.skipIf(!hayBase)('trampa en espera, con la base de verdad', () => {
	beforeAll(async () => {
		await limpiar();
		await db
			.insert(s.sensores)
			.values({ id: SENSOR, nombre: SENSOR, segmento: '-', claveHash: `x-${SENSOR}` });
		await db.insert(s.trampas).values({
			id: TRAMPA,
			nombre: 'srv-backup01',
			modulo: 'cowrie',
			tipo: 'contenedor',
			sensor: SENSOR,
			donde: '0.0.0.0:22',
			parametros: {}
		});
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('un sensor sin credencial: la trampa deja de verse activa en su último sitio', async () => {
		const p = await plan(SENSOR, false, '0.12.0');
		expect(p.trampas).toEqual([]);
		expect(await donde()).toBe(
			'en espera: este sensor aún no tiene la credencial del registro; se pondrá al día con su próxima versión'
		);
		const [t] = (await trampasConEventos()).filter((x) => x.id === TRAMPA);
		expect(t.activo && enEspera(t.donde)).toBe(true);
	});

	it('cuando el sensor se pone al día vuelve, y su sitio lo dice el sensor', async () => {
		expect((await plan(SENSOR, true, '0.13.0')).trampas).toHaveLength(1);
		expect(await donde()).toBe('desplegando…');
		await informarEstado(SENSOR, [{ id: TRAMPA, donde: '0.0.0.0:22' }]);
		expect(await donde()).toBe('0.0.0.0:22');
		await plan(SENSOR, true, '0.13.0');
		expect(await donde()).toBe('0.0.0.0:22');
	});
});
