/*
 * Rotación verificada del token de un sensor (gestion.ts, prepararToken;
 * sensor.ts, sensorDe): el nuevo convive con el anterior hasta que el sensor
 * llega con él; entonces el anterior deja de valer.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL)(
	'rotación verificada del token de un sensor',
	async () => {
		const { db, schema: s } = await import('./db');
		const { eq, like, or } = await import('drizzle-orm');
		const { prepararToken, regenerarToken } = await import('./gestion');
		const { sensorDe, VIDA_TOKEN_SIN_ESTRENAR_MS } = await import('./sensor');

		const P = 'zz-rotatoken';
		const SENSOR = `${P}-sensor`;
		const QUIEN = `${P}@prueba`;
		const VIEJO = 'zzrotatokenviejo'.repeat(3);
		const hash = (t: string) => createHash('sha256').update(t).digest('hex');

		const limpiar = async () => {
			await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
			await db
				.delete(s.auditoria)
				.where(or(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.quien, `sensor ${SENSOR}`)));
		};
		beforeEach(async () => {
			await limpiar();
			await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: hash(VIEJO) });
		});
		afterAll(limpiar);

		const entra = async (token: string) => {
			try {
				const x = await sensorDe(
					new Request('http://consola/api/sensor/plan', {
						headers: { authorization: `Bearer ${token}` }
					})
				);
				return x.id;
			} catch (e) {
				return (e as { status?: number }).status ?? 'error';
			}
		};

		it('el anterior sigue valiendo mientras el nuevo no se estrena', async () => {
			const nuevo = (await prepararToken(QUIEN, SENSOR))!;
			expect(await entra(VIEJO)).toBe(SENSOR);
			expect(await entra(VIEJO)).toBe(SENSOR);
			const [f] = await db.select().from(s.sensores).where(eq(s.sensores.id, SENSOR));
			expect(f.claveHash).toBe(hash(VIEJO));
			expect(f.claveHashSiguiente).toBe(hash(nuevo));
		});

		it('al llegar con el nuevo, pasa a ser el suyo y el anterior deja de valer', async () => {
			const nuevo = (await prepararToken(QUIEN, SENSOR))!;
			expect(await entra(nuevo)).toBe(SENSOR);
			expect(await entra(VIEJO)).toBe(401);
			expect(await entra(nuevo)).toBe(SENSOR);
			const [f] = await db.select().from(s.sensores).where(eq(s.sensores.id, SENSOR));
			expect(f.claveHash).toBe(hash(nuevo));
			expect(f.claveHashSiguiente).toBeNull();
			const rastro = await db
				.select({ accion: s.auditoria.accion })
				.from(s.auditoria)
				.where(eq(s.auditoria.quien, `sensor ${SENSOR}`));
			expect(rastro.map((r) => r.accion)).toEqual(['sensor token rotated']);
		});

		it('pedir otro sustituye al pendiente: el primero ya no se puede estrenar', async () => {
			const primero = (await prepararToken(QUIEN, SENSOR))!;
			const segundo = (await prepararToken(QUIEN, SENSOR))!;
			expect(await entra(primero)).toBe(401);
			expect(await entra(segundo)).toBe(SENSOR);
		});

		it('uno sin estrenar caduca, y el anterior sigue', async () => {
			const nuevo = (await prepararToken(QUIEN, SENSOR))!;
			await db
				.update(s.sensores)
				.set({ claveSiguienteDesde: new Date(Date.now() - VIDA_TOKEN_SIN_ESTRENAR_MS - 60_000) })
				.where(eq(s.sensores.id, SENSOR));
			expect(await entra(nuevo)).toBe(401);
			expect(await entra(VIEJO)).toBe(SENSOR);
		});

		it('cortar ya: regenerar invalida al momento el anterior y el pendiente', async () => {
			const pendiente = (await prepararToken(QUIEN, SENSOR))!;
			const cortado = (await regenerarToken(QUIEN, SENSOR))!;
			expect(await entra(VIEJO)).toBe(401);
			expect(await entra(pendiente)).toBe(401);
			expect(await entra(cortado)).toBe(SENSOR);
		});

		it('un sensor que no existe no recibe token', async () => {
			expect(await prepararToken(QUIEN, `${P}-no-existe`)).toBeNull();
		});
	}
);
