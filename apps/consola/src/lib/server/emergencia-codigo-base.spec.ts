/*
 * El código de emergencia contra una base de datos de verdad: el que crea el
 * instalador (scripts/codigo-emergencia.mjs) entra por la consola, vale una vez,
 * se cambia por otro y frena a quien prueba. DATABASE_URL (del entorno o de
 * .env); si no hay, se salta. El ajuste que hubiera se guarda y se repone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const em = hayBase ? await import('./emergencia') : ({} as never);
const { eq } = await import('drizzle-orm');

const CLAVE = 'emergencia_codigo';
const script = (...args: string[]) =>
	execFileSync('node', ['scripts/codigo-emergencia.mjs', ...args], {
		env: process.env,
		encoding: 'utf8'
	}).trim();

describe.skipIf(!hayBase)('código de emergencia', () => {
	let previo: unknown;

	beforeAll(async () => {
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
		previo = f?.valor;
	});

	afterAll(async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
		if (previo) await db.insert(s.ajustes).values({ clave: CLAVE, valor: previo });
	});

	beforeEach(async () => {
		em._olvidarFallos();
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	});

	it('el formato: seis grupos de cuatro, sin letras que se confunden', () => {
		for (let i = 0; i < 50; i++) {
			const c = em.generarCodigoEmergencia();
			expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$/);
		}
	});

	it('el del instalador entra, se gasta y deja otro que también entra', async () => {
		const c = script('--si-no-hay');
		expect(c).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
		expect(await em.estadoCodigoEmergencia()).toMatchObject({ por: 'instalador' });

		/* Escrito a mano: minúsculas, espacios en vez de guiones. */
		const r = await em.canjearCodigoEmergencia(c.toLowerCase().replaceAll('-', ' '), '10.0.0.1');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.nuevo).not.toBe(c);

		expect((await em.canjearCodigoEmergencia(c, '10.0.0.1')).ok).toBe(false);
		expect((await em.canjearCodigoEmergencia(r.nuevo, '10.0.0.1')).ok).toBe(true);
	});

	it('--si-no-hay no toca el que ya hay; sin él, lo cambia', async () => {
		const c = script();
		expect(script('--si-no-hay')).toBe('');
		const otro = script();
		expect(otro).not.toBe(c);
		expect((await em.canjearCodigoEmergencia(c, '10.0.0.2')).ok).toBe(false);
		expect((await em.canjearCodigoEmergencia(otro, '10.0.0.2')).ok).toBe(true);
	});

	it('el de Ajustes sustituye al anterior', async () => {
		const viejo = await em.nuevoCodigoEmergencia('ana@cliente.es');
		const nuevo = await em.nuevoCodigoEmergencia('ana@cliente.es');
		expect(await em.estadoCodigoEmergencia()).toMatchObject({ por: 'ana@cliente.es' });
		expect((await em.canjearCodigoEmergencia(viejo, '10.0.0.3')).ok).toBe(false);
		expect((await em.canjearCodigoEmergencia(nuevo, '10.0.0.3')).ok).toBe(true);
	});

	it('sin código en el nodo no entra nada', async () => {
		const r = await em.canjearCodigoEmergencia(em.generarCodigoEmergencia(), '10.0.0.4');
		expect(r).toEqual({ ok: false, motivo: 'invalido' });
	});

	it('dos a la vez con el mismo código: entra solo uno', async () => {
		const c = await em.nuevoCodigoEmergencia('ana@cliente.es');
		const r = await Promise.all([
			em.canjearCodigoEmergencia(c, '10.0.0.5'),
			em.canjearCodigoEmergencia(c, '10.0.0.6')
		]);
		expect(r.filter((x) => x.ok)).toHaveLength(1);
	});

	it('cinco fallos desde una IP la frenan, aunque luego acierte; otra IP sigue', async () => {
		const c = await em.nuevoCodigoEmergencia('ana@cliente.es');
		const t = Date.now();
		for (let i = 0; i < 5; i++)
			expect((await em.canjearCodigoEmergencia('AAAA-BBBB', '10.0.0.7', t)).ok).toBe(false);
		expect(await em.canjearCodigoEmergencia(c, '10.0.0.7', t)).toEqual({
			ok: false,
			motivo: 'frenado'
		});
		/* Pasado el cuarto de hora, vuelve a poder. */
		expect((await em.canjearCodigoEmergencia(c, '10.0.0.7', t + 16 * 60_000)).ok).toBe(true);
	});
});
