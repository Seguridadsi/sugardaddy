/*
 * Lo que el sensor cuenta de su máquina al informar de su estado (motor y
 * hechos, desde la 0.13.1), y los eventos con la IP del motor, contra una
 * base de datos de verdad (DATABASE_URL de .env). Si no hay, la prueba se salta.
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

const { hashEvento, leerCapacidades, GENESIS } = await import('@sugardaddy/contrato');
const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { informarEstado, plan, recibirEventos } = hayBase ? await import('./sensor') : ({} as never);
const { sensores } = hayBase ? await import('./gestion') : ({} as never);
const { eq } = await import('drizzle-orm');

const SENSOR = 'zz-prueba-estado';
const TRAMPA = 'zz-estado-t1';

async function limpiar() {
	for (const t of [s.eventos, s.cuarentena, s.rupturas])
		await db.delete(t).where(eq(t.sensor, SENSOR));
	await db.delete(s.trampas).where(eq(s.trampas.sensor, SENSOR));
	await db.delete(s.auditoria).where(eq(s.auditoria.quien, `sensor ${SENSOR}`));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
}

const fila = async () => (await db.select().from(s.sensores).where(eq(s.sensores.id, SENSOR)))[0];
const trampa = async () => (await db.select().from(s.trampas).where(eq(s.trampas.id, TRAMPA)))[0];

/* El cuerpo tal como lo manda un sensor 0.13.1 con su motor reenviando el puerto con su proxy. */
const cuerpo131 = {
	trampas: [{ id: TRAMPA, donde: '10.0.0.5:22' }],
	motor: {
		tipo: 'docker',
		modo: 'rootful',
		version: '27.5.1',
		api: '1.47',
		apiMotor: '1.47',
		apiMinima: '1.24',
		pasarelas: ['172.19.0.1']
	},
	hechos: { 'red.ipOrigenReal': { valor: false, motivo: 'origen.pasarela' } }
};

describe.skipIf(!hayBase)('estado del sensor: motor y hechos', () => {
	beforeAll(async () => {
		await limpiar();
		await db
			.insert(s.sensores)
			.values({ id: SENSOR, nombre: SENSOR, segmento: '-', claveHash: `x-${SENSOR}` });
		await db.insert(s.trampas).values({
			id: TRAMPA,
			nombre: 't1',
			sensor: SENSOR,
			modulo: 'cowrie',
			tipo: 'contenedor',
			donde: '-',
			parametros: {}
		});
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('el plan dice que esta consola admite origen.oculta', async () => {
		expect((await plan(SENSOR, true, '0.13.1')).admite).toContain('origen.oculta');
		/*
		 * Sin módulos autorizados, el plan ha dejado la trampa en espera, y un
		 * estado suyo ya no cambiaría nada (§8.1). Las de abajo la quieren en el
		 * plan.
		 */
		await db
			.update(s.trampas)
			.set({ donde: '-', colocacion: 'por-colocar', colocacionMotivo: null })
			.where(eq(s.trampas.id, TRAMPA));
	});

	it('guarda el motor y los hechos de un sensor 0.13.1', async () => {
		await informarEstado(SENSOR, cuerpo131.trampas, leerCapacidades(cuerpo131));
		const f = await fila();
		expect(f.capacidades).toMatchObject({
			motor: { tipo: 'docker', modo: 'rootful', version: '27.5.1', pasarelas: ['172.19.0.1'] },
			hechos: { 'red.ipOrigenReal': { valor: false, motivo: 'origen.pasarela' } }
		});
		expect(Date.parse(f.capacidades!.cuando)).not.toBeNaN();
		expect((await trampa()).donde).toBe('10.0.0.5:22');
	});

	it('un fallo general del motor llega a cada trampa y al bloque motor', async () => {
		const texto = 'el sensor no tiene permiso para usar el motor de contenedores';
		const c = {
			trampas: [{ id: TRAMPA, donde: `error: motor.permiso: ${texto}`, codigo: 'motor.permiso' }],
			motor: { codigo: 'motor.permiso', error: texto }
		};
		await informarEstado(SENSOR, c.trampas, leerCapacidades(c));
		expect((await trampa()).donde).toBe(`error: motor.permiso: ${texto}`);
		expect((await fila()).capacidades).toMatchObject({
			motor: { codigo: 'motor.permiso', error: texto },
			hechos: {}
		});
	});

	it('la lista de sensores cuenta sus trampas y enseña su motor y sus avisos', async () => {
		await informarEstado(SENSOR, cuerpo131.trampas, leerCapacidades(cuerpo131));
		const x = (await sensores()).find((f) => f.id === SENSOR)!;
		expect(x.trampas).toBe(1);
		expect(x.cuarentena).toBe(0);
		expect(x.rupturas).toBe(0);
		expect(x.motor).toBe('Docker 27.5.1 · con root · API 1.47');
		expect(x.avisos.map((a) => a.codigo)).toEqual(['origen.pasarela']);
		expect(x).not.toHaveProperty('capacidades');
	});

	it('un sensor 0.12 o 0.13.0 solo manda las trampas: las capacidades quedan vacías', async () => {
		const c = { trampas: [{ id: TRAMPA, donde: '10.0.0.5:22' }] };
		await informarEstado(SENSOR, c.trampas, leerCapacidades(c));
		expect((await fila()).capacidades).toBeNull();
		expect((await trampa()).donde).toBe('10.0.0.5:22');
	});

	it('un evento con la IP del motor se guarda como evento, y los de antes también', async () => {
		const base = {
			version: 2,
			cuando: '2026-10-17T10:05:00.000Z',
			trampa: { id: TRAMPA, modulo: 'cowrie', tipo: 'contenedor' },
			sensor: SENSOR,
			accion: 'conexion',
			severidad: 'baja',
			conexionEstablecida: true
		};
		const a = JSON.stringify({
			...base,
			id: '3c0e0000-0000-4000-8000-000000000001',
			origen: { ip: '172.19.0.1', puerto: 40112, oculta: true },
			hashAnterior: GENESIS
		});
		const b = JSON.stringify({
			...base,
			id: '3c0e0000-0000-4000-8000-000000000002',
			origen: { ip: '203.0.113.7', puerto: 51515 },
			hashAnterior: hashEvento(a)
		});
		const r = await recibirEventos(SENSOR, [a, b]);
		expect(r).toMatchObject({ ok: true, aceptadas: 2 });
		const eventos = await db.select().from(s.eventos).where(eq(s.eventos.sensor, SENSOR));
		expect(eventos).toHaveLength(2);
		expect(await db.select().from(s.cuarentena).where(eq(s.cuarentena.sensor, SENSOR))).toEqual([]);
		const oculto = eventos.find((e) => e.ip === '172.19.0.1')!;
		expect(JSON.parse(oculto.linea).origen.oculta).toBe(true);
	});
});
