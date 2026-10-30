/*
 * El entorno por honeypot contra Postgres de verdad (se salta sin DATABASE_URL,
 * como los demás *-base): escribir el entorno propio de una trampa
 * (cambiarEntornoTrampa) y resolver el efectivo (entornoDeTrampa), que gana lo
 * más específico sobre el del sensor (lib/entorno.ts). Todo con prefijo zz-entt.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* sin .env: hayBase será false y el bloque se salta */
}
const hayBase = !!process.env.DATABASE_URL;
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { cambiarEntornoTrampa } = hayBase ? await import('./gestion') : ({} as never);
const { entornoDeTrampa } = hayBase ? await import('./consultas') : ({} as never);
const { like } = await import('drizzle-orm');

const P = 'zz-entt';
const sensorId = `${P}-s`;
const trampaId = `${P}-t`;
const h = (i: number) => `${i}`.repeat(64).slice(0, 64);
const quien = `${P}-admin`;

async function limpiar() {
	await db.delete(s.trampas).where(like(s.trampas.id, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
	await db.delete(s.auditoria).where(like(s.auditoria.quien, `${P}%`));
}

describe.skipIf(!hayBase)('el entorno por honeypot, contra la base', () => {
	beforeAll(async () => {
		await limpiar();
		/* El sensor está de cara a la web; la trampa, sin entorno propio: lo hereda. */
		await db
			.insert(s.sensores)
			.values({ id: sensorId, nombre: sensorId, claveHash: h(1), entorno: 'perimetro-web' });
		await db.insert(s.trampas).values({
			id: trampaId,
			nombre: trampaId,
			modulo: 'cowrie',
			tipo: 'contenedor',
			sensor: sensorId,
			donde: sensorId,
			entorno: null
		});
	});

	afterAll(async () => {
		if (!process.env.CONSERVAR) await limpiar();
	});

	it('sin entorno propio: hereda el del sensor', async () => {
		const e = await entornoDeTrampa(trampaId);
		expect(e).toEqual({ propio: null, sensor: 'perimetro-web', efectivo: 'perimetro-web' });
	});

	it('cambiar el entorno de la trampa: su propio gana sobre el del sensor', async () => {
		expect(await cambiarEntornoTrampa(quien, trampaId, 'dentro')).toBe(true);
		const e = await entornoDeTrampa(trampaId);
		expect(e).toEqual({ propio: 'dentro', sensor: 'perimetro-web', efectivo: 'dentro' });
	});

	it('vaciarlo (null): vuelve a heredar del sensor', async () => {
		expect(await cambiarEntornoTrampa(quien, trampaId, null)).toBe(true);
		const e = await entornoDeTrampa(trampaId);
		expect(e?.efectivo).toBe('perimetro-web');
		expect(e?.propio).toBeNull();
	});

	it('una trampa que no existe: el escritor devuelve false y el resolvedor null', async () => {
		expect(await cambiarEntornoTrampa(quien, `${P}-no-existe`, 'dentro')).toBe(false);
		expect(await entornoDeTrampa(`${P}-no-existe`)).toBeNull();
	});
});
