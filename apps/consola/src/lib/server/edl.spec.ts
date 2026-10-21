/*
 * La lista que leen los firewalls contra la base de datos de desarrollo
 * (DATABASE_URL de .env). Si no hay, la prueba se salta.
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
const { edl } = hayBase ? await import('./inteligencia') : ({} as never);
const { contenidaEn } = await import('@sugardaddy/canal');
const { eq } = await import('drizzle-orm');

const QUIEN = 'prueba-edl';
const fila = (valor: string, lista: 'negra' | 'blanca') => ({
	valor,
	clase: valor.includes('/') ? ('red' as const) : ('ip' as const),
	lista,
	ambito: 'local' as const,
	motivo: 'prueba',
	quien: QUIEN
});

describe.skipIf(!hayBase)('EDL: la blanca gana siempre', () => {
	beforeAll(async () => {
		await db.delete(s.listas).where(eq(s.listas.quien, QUIEN));
		await db
			.insert(s.listas)
			.values([fila('100.64.0.0/16', 'negra'), fila('100.64.7.7', 'blanca')])
			.onConflictDoNothing();
	});
	afterAll(async () => {
		if (hayBase) await db.delete(s.listas).where(eq(s.listas.quien, QUIEN));
	});

	it('una red negra que contiene una IP blanca se publica partida, sin ella', async () => {
		const lista = await edl();
		expect(lista).not.toContain('100.64.0.0/16');
		expect(lista.some((c) => contenidaEn('100.64.7.7', [c]))).toBe(false);
		expect(lista.some((c) => contenidaEn('100.64.7.8', [c]))).toBe(true);
		expect(lista.some((c) => contenidaEn('100.64.255.255', [c]))).toBe(true);
	});
});
