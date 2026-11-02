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
const { edl, edlDominios } = hayBase ? await import('./inteligencia') : ({} as never);
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

describe.skipIf(!hayBase)('EDL: una entrada blanca caducada ya no protege', () => {
	const QC = 'prueba-edl-caduca';
	const ayer = new Date(Date.now() - 86_400_000);
	beforeAll(async () => {
		await db.delete(s.listas).where(eq(s.listas.quien, QC));
		await db
			.insert(s.listas)
			.values([
				{ ...fila('203.0.113.50', 'negra'), quien: QC },
				{ ...fila('203.0.113.50', 'blanca'), quien: QC, caduca: ayer }
			])
			.onConflictDoNothing();
	});
	afterAll(async () => {
		if (hayBase) await db.delete(s.listas).where(eq(s.listas.quien, QC));
	});

	it('la IP tapada solo por una blanca vencida vuelve a bloquearse', async () => {
		const lista = await edl();
		expect(lista).toContain('203.0.113.50');
	});
});

describe.skipIf(!hayBase)('EDL de dominios: negra vigente menos blanca', () => {
	const QD = 'prueba-edl-dominios';
	const ayer = new Date(Date.now() - 86_400_000);
	const dom = (valor: string, lista: 'negra' | 'blanca', caduca: Date | null = null) => ({
		valor,
		clase: 'dominio' as const,
		lista,
		ambito: 'local' as const,
		motivo: 'prueba',
		quien: QD,
		caduca
	});
	beforeAll(async () => {
		await db.delete(s.listas).where(eq(s.listas.quien, QD));
		await db
			.insert(s.listas)
			.values([
				dom('malo.example', 'negra'),
				dom('caducado.example', 'negra', ayer),
				dom('bueno.example', 'negra'), // tapado por la blanca
				dom('sub.bueno.example', 'negra'), // tapado por subdominio de la blanca
				dom('bueno.example', 'blanca')
			])
			.onConflictDoNothing();
	});
	afterAll(async () => {
		if (hayBase) await db.delete(s.listas).where(eq(s.listas.quien, QD));
	});

	it('lista los dominios negros vigentes y no los caducados, blancos ni sus subdominios', async () => {
		const lista = await edlDominios();
		expect(lista).toContain('malo.example');
		expect(lista).not.toContain('caducado.example');
		expect(lista).not.toContain('bueno.example');
		expect(lista).not.toContain('sub.bueno.example');
	});
});
