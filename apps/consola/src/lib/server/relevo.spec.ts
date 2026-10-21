/*
 * El cerrojo del relevo contra la base de datos de desarrollo (DATABASE_URL
 * de .env). Si no hay, la prueba se salta.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const canal = hayBase ? await import('./canal') : ({} as never);
const { eq, inArray } = await import('drizzle-orm');

const CLAVES = ['relevo', 'relevo-intentos'];
const limpiar = () => db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));

describe.skipIf(!hayBase)('cerrojo del relevo', () => {
	beforeEach(limpiar);
	afterAll(limpiar);

	it('dos sensores a la vez: solo uno se lo lleva', async () => {
		const r = await Promise.all([
			canal.tomarCerrojo('zz-a', true, '0.12.0'),
			canal.tomarCerrojo('zz-b', true, '0.12.0')
		]);
		expect(r.filter(Boolean)).toHaveLength(1);
	});

	it('no se renueva: caduca a los 30 minutos del primer «aplicando»', async () => {
		expect(await canal.tomarCerrojo('zz-a', true, '0.12.0')).toBe(true);
		const hace = new Date(Date.now() - 29 * 60_000).toISOString();
		await db
			.update(s.ajustes)
			.set({ valor: { sensor: 'zz-a', remoto: true, desde: hace } })
			.where(eq(s.ajustes.clave, 'relevo'));
		expect(await canal.tomarCerrojo('zz-a', true, '0.12.0')).toBe(true);
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'relevo'));
		expect((f.valor as { desde: string }).desde).toBe(hace);
		// Caducado, otro sensor puede tomarlo.
		await db
			.update(s.ajustes)
			.set({
				valor: {
					sensor: 'zz-a',
					remoto: true,
					desde: new Date(Date.now() - 31 * 60_000).toISOString()
				}
			})
			.where(eq(s.ajustes.clave, 'relevo'));
		expect(await canal.tomarCerrojo('zz-b', true, '0.12.0')).toBe(true);
	});

	it('solo lo suelta quien lo tiene', async () => {
		await canal.tomarCerrojo('zz-a', true, '0.12.0');
		await canal.soltarRelevo('zz-b');
		expect((await canal.relevoEnCurso())?.sensor).toBe('zz-a');
		await canal.soltarRelevo('zz-a');
		expect(await canal.relevoEnCurso()).toBeNull();
	});

	it('el relevo de un remoto no retiene al actualizador del nodo', async () => {
		await canal.tomarCerrojo('zz-a', true, '0.12.0');
		expect(await canal.retenido('zz-a')).toBe(true);
		expect(await canal.retenido('zz-b')).toBe(false);
		expect(await canal.retenido()).toBe(false);
		await canal.soltarRelevo('zz-a');
		await canal.tomarCerrojo('zz-local', false, '0.12.0');
		expect(await canal.retenido()).toBe(true);
	});

	it('cada sensor tiene un número de intentos por versión', async () => {
		for (let i = 0; i < 5; i++) {
			expect(await canal.tomarCerrojo('zz-a', true, '0.12.0')).toBe(true);
			await canal.soltarRelevo('zz-a');
		}
		expect(await canal.tomarCerrojo('zz-a', true, '0.12.0')).toBe(false);
		expect(await canal.tomarCerrojo('zz-a', true, '0.12.1')).toBe(true);
	});
});
