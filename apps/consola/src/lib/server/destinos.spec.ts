/*
 * Destinos con la consola de hoy: el sensor nace con su destino, «Instalar un
 * sensor aquí» no crea otro, retirar un sensor deja su destino si tiene
 * trampas y no se retira una trampa que recibe la señal de otra. Contra una
 * base de datos de verdad (DATABASE_URL de .env); si no hay, se salta.
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
const { crearSensor, DestinoNoDisponible, retirarSensor, retirarTrampa, trampaQuitada } = hayBase
	? await import('./gestion')
	: ({} as never);
const { crearDestino } = hayBase ? await import('./destinos') : ({} as never);
const { crearTrampa } = hayBase ? await import('./consultas') : ({} as never);
const { and, eq, inArray, like, or } = await import('drizzle-orm');

const QUIEN = 'zz-prueba-destinos';
/* Todo lo de esta prueba empieza por zz-dst: así se limpia sin tocar nada más. */
const P = 'zz-dst';
const sensor = (id: string) =>
	crearSensor(QUIEN, { id, nombre: `Sensor ${id}`, segmento: 'pruebas' });

async function limpiar() {
	const mias = like(s.trampas.id, `${P}%`);
	await db.update(s.trampas).set({ senalTrampa: null }).where(mias);
	await db.delete(s.eventos).where(like(s.eventos.sensor, `${P}%`));
	await db.delete(s.trampas).where(mias);
	await db.delete(s.destinos).where(like(s.destinos.id, `${P}%`));
	await db.delete(s.instaladoresSensor).where(like(s.instaladoresSensor.sensor, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
	await db.delete(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
}

const destinos = async () =>
	db
		.select({ id: s.destinos.id, sensor: s.destinos.sensor })
		.from(s.destinos)
		.where(or(like(s.destinos.id, `${P}%`), like(s.destinos.sensor, `${P}%`)))
		.orderBy(s.destinos.id);

const trampa = (v: {
	id: string;
	sensor: string;
	destino?: string | null;
	ejecutor?: string;
	senalTrampa?: string;
}) =>
	db.insert(s.trampas).values({
		nombre: `Trampa ${v.id}`,
		modulo: v.ejecutor === 'manual@1' ? 'credencial-ssh' : 'cowrie',
		tipo: v.ejecutor === 'manual@1' ? 'identidad' : 'contenedor',
		donde: '-',
		parametros: {},
		...(v.ejecutor === 'manual@1' ? { via: 'windows' } : {}),
		...v
	});

describe.skipIf(!hayBase)('destinos con la consola de hoy', () => {
	beforeAll(limpiar);
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('un sensor nuevo nace con su destino, una máquina con su id', async () => {
		expect(await sensor(`${P}-a`)).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const [d] = await db
			.select()
			.from(s.destinos)
			.where(eq(s.destinos.id, `${P}-a`));
		expect(d).toMatchObject({
			nombre: `Sensor ${P}-a`,
			tipo: 'maquina',
			sensor: `${P}-a`,
			descripcion: {},
			activo: true
		});
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, 'sensor dado de alta')));
		expect(a.detalle).toMatchObject({ id: `${P}-a`, destino: `${P}-a` });
	});

	it('el mismo id de sensor otra vez no da otro sensor ni otro destino', async () => {
		expect(await sensor(`${P}-a`)).toBeNull();
		expect(await destinos()).toEqual([{ id: `${P}-a`, sensor: `${P}-a` }]);
	});

	it('un destino descrito a mano y un sensor nuevo con el mismo nombre dan dos destinos', async () => {
		const fs01 = await crearDestino(QUIEN, {
			nombre: `${P}-fs01`,
			tipo: 'fileserver',
			descripcion: { so: 'windows', powershell: '5.1', direccion: '10.0.0.9' }
		});
		expect(fs01).toBe(`${P}-fs01`);
		expect(await sensor(`${P}-fs01`)).not.toBeNull();
		expect((await destinos()).filter((d) => d.id.startsWith(`${P}-fs01`))).toEqual([
			{ id: `${P}-fs01`, sensor: null },
			{ id: `${P}-fs01-2`, sensor: `${P}-fs01` }
		]);
		/* Y un tercero con el mismo nombre, el siguiente sufijo. */
		expect(await crearDestino(QUIEN, { nombre: `${P}-FS01`, tipo: 'maquina' })).toBe(`${P}-fs01-3`);
	});

	it('«Instalar un sensor aquí» deja el destino con el sensor sin crear otro', async () => {
		const n = (await destinos()).length;
		const token = await crearSensor(
			QUIEN,
			{ id: `${P}-sensor-fs01`, nombre: 'Sensor de fs01', segmento: 'sede', remoto: true },
			`${P}-fs01`
		);
		expect(token).not.toBeNull();
		expect((await destinos()).length).toBe(n);
		const [d] = await db
			.select()
			.from(s.destinos)
			.where(eq(s.destinos.id, `${P}-fs01`));
		/* Las respuestas del formulario siguen ahí para lo que el sensor no informa. */
		expect(d).toMatchObject({
			sensor: `${P}-sensor-fs01`,
			tipo: 'fileserver',
			descripcion: { so: 'windows', powershell: '5.1', direccion: '10.0.0.9' }
		});
	});

	it('en un destino que ya tiene sensor o está dado de baja no se instala otro, y no queda el sensor', async () => {
		const otro = { id: `${P}-intruso`, nombre: 'Intruso', segmento: 'x', remoto: true };
		await expect(crearSensor(QUIEN, otro, `${P}-fs01`)).rejects.toBeInstanceOf(DestinoNoDisponible);
		const baja = await crearDestino(QUIEN, { nombre: `${P}-baja`, tipo: 'maquina' });
		await db.update(s.destinos).set({ activo: false }).where(eq(s.destinos.id, baja));
		await expect(crearSensor(QUIEN, otro, baja)).rejects.toBeInstanceOf(DestinoNoDisponible);
		await expect(crearSensor(QUIEN, otro, `${P}-no-existe`)).rejects.toBeInstanceOf(
			DestinoNoDisponible
		);
		expect(await db.select().from(s.sensores).where(eq(s.sensores.id, otro.id))).toEqual([]);
	});

	it('una trampa nueva se guarda en el destino que le da el alta, con su vía y su ejecutor', async () => {
		/* El destino del sensor fs01 es fs01-2: el id del destino no es el del sensor. */
		const nueva = {
			id: `${P}-t-nueva`,
			nombre: 'nueva',
			modulo: 'cowrie',
			tipo: 'contenedor' as const,
			destino: `${P}-fs01-2`,
			via: 'contenedor',
			ejecutor: 'contenedor@1',
			sensor: `${P}-fs01`,
			parametros: {}
		};
		expect(await crearTrampa(QUIEN, nueva)).toBe(true);
		/* Dos altas con el mismo id a la vez: la segunda no se guarda (ni falla). */
		expect(await crearTrampa(QUIEN, { ...nueva, nombre: 'otra' })).toBe(false);
		const [t] = await db
			.select()
			.from(s.trampas)
			.where(eq(s.trampas.id, `${P}-t-nueva`));
		expect(t).toMatchObject({
			nombre: 'nueva',
			destino: `${P}-fs01-2`,
			via: 'contenedor',
			ejecutor: 'contenedor@1',
			colocacion: 'por-colocar'
		});
		expect(await retirarTrampa(QUIEN, `${P}-t-nueva`)).toBe('retirada');
	});

	describe('una trampa manual en el destino del sensor B con la señal en el sensor A', () => {
		const A = `${P}-a`;
		const B = `${P}-b`;
		const OBJETIVO = `${P}-t-cowrie`;
		const MANUAL = `${P}-t-credencial`;

		beforeAll(async () => {
			await sensor(B);
			await trampa({ id: OBJETIVO, sensor: A, destino: A });
			await trampa({
				id: MANUAL,
				sensor: A,
				destino: B,
				ejecutor: 'manual@1',
				senalTrampa: OBJETIVO
			});
		});

		it('retirar B deja su destino sin sensor y con la trampa', async () => {
			expect(await retirarSensor(QUIEN, B)).toBe('retirado');
			expect(await db.select().from(s.sensores).where(eq(s.sensores.id, B))).toEqual([]);
			expect((await destinos()).find((d) => d.id === B)).toEqual({ id: B, sensor: null });
			const [m] = await db.select().from(s.trampas).where(eq(s.trampas.id, MANUAL));
			expect(m).toMatchObject({ destino: B, sensor: A, senalTrampa: OBJETIVO });
			const [a] = await db
				.select()
				.from(s.auditoria)
				.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, 'sensor retirado')));
			expect(a.detalle).toEqual({ id: B, destino: B, destinoQueda: true });
		});

		it('retirar A se niega: tiene trampas', async () => {
			expect(await retirarSensor(QUIEN, A)).toBe('tiene trampas');
			expect((await destinos()).find((d) => d.id === A)).toEqual({ id: A, sensor: A });
		});

		it('retirar la trampa que recibe la señal se niega y dice cuál retirar antes', async () => {
			expect(await retirarTrampa(QUIEN, OBJETIVO)).toEqual({ dependientes: [`Trampa ${MANUAL}`] });
			expect(await db.select().from(s.trampas).where(eq(s.trampas.id, OBJETIVO))).toHaveLength(1);
		});

		it('retirada la manual, la otra ya se puede retirar', async () => {
			/* La manual se retira con sus pasos: queda retirando hasta que se dice que ya no está. */
			expect(await retirarTrampa(QUIEN, MANUAL)).toBe('retirando');
			expect(await retirarTrampa(QUIEN, OBJETIVO)).toEqual({ dependientes: [`Trampa ${MANUAL}`] });
			expect(await trampaQuitada(QUIEN, MANUAL)).toBe('retirada');
			expect(await retirarTrampa(QUIEN, OBJETIVO)).toBe('retirada');
			expect(await retirarTrampa(QUIEN, OBJETIVO)).toBe('no-existe');
			const r = await db
				.select()
				.from(s.auditoria)
				.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, 'trampa retirada')));
			expect(r.map((x) => x.detalle)).toEqual(
				expect.arrayContaining([
					{ id: MANUAL, modulo: 'credencial-ssh', sensor: A, destino: B },
					{ id: OBJETIVO, modulo: 'cowrie', sensor: A, destino: A }
				])
			);
		});
	});

	it('un sensor sin trampas en su destino se retira con su destino', async () => {
		await sensor(`${P}-c`);
		expect(await retirarSensor(QUIEN, `${P}-c`)).toBe('retirado');
		expect((await destinos()).find((d) => d.id === `${P}-c`)).toBeUndefined();
	});

	it('un sensor con eventos se desactiva y su destino se queda con él', async () => {
		await sensor(`${P}-d`);
		await db.insert(s.eventos).values({
			id: '2b0e0000-0000-4000-8000-00000000d5d5',
			sensor: `${P}-d`,
			linea: '{}',
			hash: `${P}-d-hash`,
			cuando: new Date(),
			trampa: `${P}-t-vieja`,
			modulo: 'cowrie',
			tipo: 'contenedor',
			accion: 'conexion',
			severidad: 'media',
			conexionEstablecida: true
		});
		expect(await retirarSensor(QUIEN, `${P}-d`)).toBe('desactivado');
		expect((await destinos()).find((d) => d.id === `${P}-d`)).toEqual({
			id: `${P}-d`,
			sensor: `${P}-d`
		});
	});

	it('los destinos de esta prueba son los que tocan', async () => {
		expect((await destinos()).map((d) => d.id)).toEqual(
			[`${P}-a`, `${P}-b`, `${P}-baja`, `${P}-d`, `${P}-fs01`, `${P}-fs01-2`, `${P}-fs01-3`].sort()
		);
		expect(
			await db
				.select({ id: s.trampas.id })
				.from(s.trampas)
				.where(inArray(s.trampas.destino, [`${P}-a`, `${P}-b`]))
		).toEqual([]);
	});
});
