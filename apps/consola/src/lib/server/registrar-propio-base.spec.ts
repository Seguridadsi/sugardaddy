/*
 * El interruptor de lo que viene de la propia máquina del sensor: lo que le dice el
 * plan, por su ruta, y lo que deja en la auditoría. Lo que hace el sensor con ello
 * está en sensor/cmd/sensor/propio_test.go.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL)('registrar lo del propio sensor', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, like } = await import('drizzle-orm');
	const { cambiarRegistrarPropio, sensores } = await import('./gestion');
	const { GET } = await import('../../routes/api/sensor/plan/+server');
	const { actions } = await import('../../routes/sensors/+page.server');

	const P = 'zz-propio';
	const SENSOR = `${P}-sensor`;
	const OTRO = `${P}-otro`;
	const QUIEN = `${P}@prueba`;
	const TOKEN = 'zzpropio'.repeat(5);

	const limpiar = async () => {
		await db.delete(s.balizas).where(like(s.balizas.token, `${P}%`));
		await db.delete(s.trampas).where(like(s.trampas.id, `${P}%`));
		await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
		await db.delete(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
	};
	beforeEach(async () => {
		await limpiar();
		await db.insert(s.sensores).values([
			{
				id: SENSOR,
				nombre: SENSOR,
				claveHash: createHash('sha256').update(TOKEN).digest('hex')
			},
			{ id: OTRO, nombre: OTRO, claveHash: `${P}-x` }
		]);
	});
	afterAll(limpiar);

	const pedirPlan = async () =>
		(
			await GET({
				request: new Request('http://consola/api/sensor/plan', {
					headers: { authorization: `Bearer ${TOKEN}` }
				})
			} as never)
		).json();

	const trampa = (id: string, sensor: string, senalTrampa?: string) =>
		db.insert(s.trampas).values({
			id,
			nombre: id,
			modulo: 'cowrie',
			tipo: 'contenedor',
			sensor,
			donde: 'zz',
			...(senalTrampa ? { senalTrampa } : {})
		});
	/* Una prueba abierta en esa trampa, o ya vencida si se le pide. */
	const prueba = (t: string, minutos = 15) =>
		db.insert(s.pruebas).values({
			trampa: t,
			nonce: 'abcd1234',
			hasta: new Date(Date.now() + minutos * 60_000),
			quien: QUIEN
		});

	it('por defecto no registra, y el plan se lo pide al sensor', async () => {
		expect((await sensores()).find((x) => x.id === SENSOR)?.registrarPropio).toBe(false);
		const p = await pedirPlan();
		expect(p.ignorarPropio).toBe(true);
		expect(p.registrarSiempre).toEqual([]);
	});

	it('encendido, el plan no dice nada: como una consola anterior', async () => {
		expect(await cambiarRegistrarPropio(QUIEN, SENSOR, true)).toBe(true);
		const p = await pedirPlan();
		expect(p).not.toHaveProperty('ignorarPropio');
		expect(p).not.toHaveProperty('registrarSiempre');
		await cambiarRegistrarPropio(QUIEN, SENSOR, false);
		expect((await pedirPlan()).ignorarPropio).toBe(true);
	});

	it('deja rastro en la auditoría, y solo toca ese sensor', async () => {
		await cambiarRegistrarPropio(QUIEN, SENSOR, true);
		await cambiarRegistrarPropio(QUIEN, SENSOR, false);
		const filas = await db
			.select({ accion: s.auditoria.accion, detalle: s.auditoria.detalle })
			.from(s.auditoria)
			.where(eq(s.auditoria.quien, QUIEN));
		expect(filas.map((f) => f.accion).sort()).toEqual([
			'sensor own-machine recording disabled',
			'sensor own-machine recording enabled'
		]);
		expect(filas[0].detalle).toEqual({ id: SENSOR });
		await cambiarRegistrarPropio(QUIEN, SENSOR, true);
		expect((await sensores()).find((x) => x.id === OTRO)?.registrarPropio).toBe(false);
	});

	describe('la casilla de la pantalla', () => {
		const pedir = (cuerpo: Record<string, string>, roles = ['admin']) => {
			const form = new FormData();
			for (const [k, v] of Object.entries(cuerpo)) form.set(k, v);
			return actions.registrarPropio({
				request: new Request('http://consola/sensors', { method: 'POST', body: form }),
				locals: { usuario: { nombre: 'Prueba', correo: QUIEN, roles } }
			} as never);
		};
		const registrando = async () =>
			(await sensores()).find((x) => x.id === SENSOR)?.registrarPropio;

		it('marcada registra, y sin marcar (el navegador no la manda) deja de hacerlo', async () => {
			expect(await pedir({ id: SENSOR, registrar: 'si' })).toMatchObject({
				mensaje: expect.stringContaining('will record')
			});
			expect(await registrando()).toBe(true);
			expect(await pedir({ id: SENSOR })).toMatchObject({
				mensaje: expect.stringContaining('will stop recording')
			});
			expect(await registrando()).toBe(false);
		});

		it('solo quien puede tocar los ajustes', async () => {
			await expect(pedir({ id: SENSOR, registrar: 'si' }, ['lector'])).rejects.toMatchObject({
				status: 403
			});
			expect(await registrando()).toBe(false);
		});

		it('de un sensor que ya no existe, lo dice', async () => {
			expect(await pedir({ id: `${P}-nadie`, registrar: 'si' })).toMatchObject({ status: 404 });
		});
	});

	it('de un sensor que no existe, lo dice', async () => {
		expect(await cambiarRegistrarPropio(QUIEN, `${P}-nadie`, true)).toBe(false);
	});

	const siempre = async () => ((await pedirPlan()).registrarSiempre as string[]).sort();

	it('registrarSiempre lleva las trampas con una prueba abierta de ese sensor, sin repetir', async () => {
		await trampa(`${P}-a`, SENSOR);
		await trampa(`${P}-b`, SENSOR);
		await trampa(`${P}-vencida`, SENSOR);
		await trampa(`${P}-de-otro`, OTRO);
		await prueba(`${P}-a`);
		await prueba(`${P}-a`);
		await prueba(`${P}-vencida`, -60);
		await prueba(`${P}-de-otro`);
		expect(await siempre()).toEqual([`${P}-a`]);
	});

	/*
	 * Un cebo puesto en la máquina del sensor solo puede avisar desde ella: es lo que
	 * vigila. Si lo descartara, el cebo dejaría de valer sin que nada lo dijera.
	 */
	it('la trampa a la que apunta un cebo registra siempre, sin hacer falta una prueba', async () => {
		await trampa(`${P}-receptora`, SENSOR);
		await trampa(`${P}-sembrada`, SENSOR, `${P}-receptora`);
		await trampa(`${P}-sola`, SENSOR);
		expect(await siempre()).toEqual([`${P}-receptora`]);
	});

	it('también si el cebo es de otro sensor; y no dice nada de las trampas de los demás', async () => {
		await trampa(`${P}-receptora`, SENSOR);
		await trampa(`${P}-sembrada`, OTRO, `${P}-receptora`);
		await trampa(`${P}-receptora-otro`, OTRO);
		await trampa(`${P}-sembrada-2`, SENSOR, `${P}-receptora-otro`);
		expect(await siempre()).toEqual([`${P}-receptora`]);
	});

	it('el receptor de las balizas de ese sensor registra siempre', async () => {
		await trampa(`${P}-receptor`, SENSOR);
		await trampa(`${P}-documento`, SENSOR);
		await trampa(`${P}-documento-2`, SENSOR);
		await trampa(`${P}-documento-3`, SENSOR);
		await trampa(`${P}-receptor-otro`, OTRO);
		await trampa(`${P}-documento-otro`, OTRO);
		const baliza = (token: string, trampa: string, sensor: string, receptor: string | null) => ({
			token: `${P}-${token}`,
			trampa,
			sensor,
			receptor,
			url: `https://zz/${token}`
		});
		await db
			.insert(s.balizas)
			.values([
				baliza('uno', `${P}-documento`, SENSOR, `${P}-receptor`),
				baliza('dos', `${P}-documento-2`, SENSOR, `${P}-receptor`),
				baliza('sin-receptor', `${P}-documento-3`, SENSOR, null),
				baliza('otro', `${P}-documento-otro`, OTRO, `${P}-receptor-otro`)
			]);
		expect(await siempre()).toEqual([`${P}-receptor`]);
	});

	it('lo que tiene varias razones sale una vez', async () => {
		await trampa(`${P}-receptora`, SENSOR);
		await trampa(`${P}-sembrada`, SENSOR, `${P}-receptora`);
		await prueba(`${P}-sembrada`);
		await prueba(`${P}-receptora`);
		expect(await siempre()).toEqual([`${P}-receptora`]);
	});
});
