/*
 * El plan contra una base de datos de verdad (docs/diseno/modulo-despliegue.md,
 * paso 8): solo lleva trampas de contenedor@1, deja fuera lo demás con el
 * código de su motivo y lo apunta en la trampa. Y el alta de hoy, que guarda
 * la vía con que se pone. DATABASE_URL de .env, como recepcion.spec.ts; si no
 * hay, se salta.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { leerHoneycosa } from '@sugardaddy/contrato';

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
/* Lo que autoriza el panel: aquí, solo cowrie. */
vi.mock('./catalogo', async (original) => {
	const catalogo = await original<typeof import('./catalogo')>();
	return {
		...catalogo,
		autorizados: async () => ['cowrie'],
		trampasAutorizadas: async () => catalogo.honeycosas().filter((h) => h.id === 'cowrie')
	};
});

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { plan } = hayBase ? await import('./sensor') : ({} as never);
const rutaAlta = hayBase ? await import('../../routes/trampas/nueva/[modulo]/+page.server') : null;
const { eq, like } = await import('drizzle-orm');

/* Todo lo de esta prueba empieza por zz-pb: así se limpia sin tocar nada más. */
const P = 'zz-pb';
const SENSOR = `${P}-s1`;
const QUIEN = 'zz-prueba-plan-base';

async function limpiar() {
	await db.delete(s.trampas).where(like(s.trampas.id, `${P}%`));
	await db.delete(s.destinos).where(eq(s.destinos.sensor, SENSOR));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
	await db.delete(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
}

const trampa = async (id: string) =>
	(await db.select().from(s.trampas).where(eq(s.trampas.id, id)))[0];

describe.skipIf(!hayBase)('el plan con la base de datos', () => {
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		const comun = { sensor: SENSOR, tipo: 'contenedor' as const, parametros: {} };
		await db.insert(s.trampas).values([
			{ ...comun, id: `${P}-ssh`, nombre: 'ssh', modulo: 'cowrie', donde: '0.0.0.0:2222' },
			/*
			 * Una manual cuya señal recibe este sensor (§8.5): de un módulo que la
			 * consola conoce y autoriza, y aun así no es del sensor.
			 */
			{
				...comun,
				id: `${P}-manual`,
				nombre: 'manual',
				modulo: 'cowrie',
				via: 'windows',
				ejecutor: 'manual@1',
				donde: '-'
			},
			{ ...comun, id: `${P}-redis`, nombre: 'redis', modulo: 'redis', donde: '0.0.0.0:6379' }
		]);
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('una fila de manual@1 nunca aparece en el plan, ni como descartada, ni se toca', async () => {
		const p = await plan(SENSOR, true, '0.13.1');
		expect(p.trampas.map((t) => t.id)).toEqual([`${P}-ssh`]);
		expect(p.senuelos).toBe(p.trampas);
		expect(p.descartados.map((d) => d.id)).toEqual([`${P}-redis`]);
		expect(await trampa(`${P}-manual`)).toMatchObject({ donde: '-', colocacionMotivo: null });
	});

	it('lo que deja fuera queda en espera, con el mismo texto que hoy y el código en la trampa', async () => {
		const p = await plan(SENSOR, true, '0.13.1');
		expect(p.descartados).toEqual([
			{
				id: `${P}-redis`,
				codigo: 'modulo.no-autorizado',
				motivo: 'el módulo redis no está autorizado'
			}
		]);
		expect(await trampa(`${P}-redis`)).toMatchObject({
			donde: 'en espera: el módulo redis no está autorizado',
			colocacionMotivo: 'modulo.no-autorizado'
		});
		/* La que sigue en el plan no se toca. */
		expect(await trampa(`${P}-ssh`)).toMatchObject({
			donde: '0.0.0.0:2222',
			colocacionMotivo: null
		});
	});

	it('si cambia la causa, cambian el texto y el código', async () => {
		await db
			.update(s.trampas)
			.set({ modulo: 'no-existe' })
			.where(eq(s.trampas.id, `${P}-redis`));
		const p = await plan(SENSOR, true, '0.13.1');
		expect(p.descartados).toEqual([
			{
				id: `${P}-redis`,
				codigo: 'modulo.desconocido',
				motivo: 'el módulo no-existe no está en el catálogo'
			}
		]);
		expect(await trampa(`${P}-redis`)).toMatchObject({
			donde: 'en espera: el módulo no-existe no está en el catálogo',
			colocacionMotivo: 'modulo.desconocido'
		});
	});
});

/*
 * El alta guarda la vía que elige el elector en el destino (paso 9): en una
 * máquina con sensor, la contenedor@1 del módulo, con su id de hoy en
 * trampas.via. Un v2 puede llamarla de otra forma, y aun así la trampa entra
 * en el plan.
 */
describe.skipIf(!hayBase)('el alta guarda la vía con que se pone', () => {
	const cowrie = readFileSync('../../modulos/trampas/cowrie/trampa.yaml', 'utf8');
	let carpeta = '';
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({
			id: SENSOR,
			nombre: SENSOR,
			claveHash: `x-${SENSOR}`,
			ultimoLatido: new Date()
		});
		await db
			.insert(s.destinos)
			.values({ id: SENSOR, nombre: SENSOR, tipo: 'maquina', sensor: SENSOR });
	});
	afterAll(async () => {
		delete process.env.SUGARDADDY_MODULOS;
		if (carpeta) rmSync(carpeta, { recursive: true, force: true });
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	async function alta(id: string, puertoSsh: string) {
		const f = new FormData();
		for (const [k, v] of Object.entries({
			id,
			nombre: id,
			destino: SENSOR,
			'p.puertoSsh': puertoSsh
		}))
			f.append(k, v);
		try {
			return await rutaAlta!.actions.default({
				params: { modulo: 'cowrie' },
				request: new Request('http://consola/trampas/nueva/cowrie', { method: 'POST', body: f }),
				locals: { usuario: { nombre: 'Prueba', correo: QUIEN, roles: ['admin'] } }
			} as never);
		} catch (e) {
			return e;
		}
	}

	it('con un módulo v1, la vía contenedor', async () => {
		expect(await alta(`${P}-alta-v1`, '2201')).toMatchObject({ status: 303 });
		expect(await trampa(`${P}-alta-v1`)).toMatchObject({
			modulo: 'cowrie',
			destino: SENSOR,
			via: 'contenedor',
			ejecutor: 'contenedor@1',
			sensor: SENSOR
		});
		/* La auditoría dice también dónde y cómo se puso. */
		const [a] = await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
		expect(a).toMatchObject({ accion: 'trampa creada' });
		expect(a.detalle).toMatchObject({
			id: `${P}-alta-v1`,
			destino: SENSOR,
			via: 'contenedor',
			ejecutor: 'contenedor@1',
			sensor: SENSOR,
			parametros: { puertoSsh: 2201 }
		});
	});

	it('con cowrie en v2 y su vía llamada «sensor», la vía sensor, y entra en el plan', async () => {
		const r = leerHoneycosa(cowrie);
		if (!r.ok) throw new Error(r.errores.join('\n'));
		const { origen, ...h } = r.valor;
		carpeta = mkdtempSync(join(tmpdir(), 'sd-alta-'));
		mkdirSync(join(carpeta, 'trampas/cowrie'), { recursive: true });
		writeFileSync(
			join(carpeta, 'trampas/cowrie/trampa.yaml'),
			JSON.stringify({ ...h, vias: [{ ...h.vias[0], id: 'sensor' }] })
		);
		process.env.SUGARDADDY_MODULOS = carpeta;
		expect(origen).toBe(1);

		expect(await alta(`${P}-alta-v2`, '2202')).toMatchObject({ status: 303 });
		expect(await trampa(`${P}-alta-v2`)).toMatchObject({ via: 'sensor', ejecutor: 'contenedor@1' });
		const p = await plan(SENSOR, true, '0.13.1');
		expect(p.trampas.map((t) => t.id)).toEqual([`${P}-alta-v2`]);
		/* La de antes se puso con la vía contenedor, que este cowrie ya no tiene ni en un antes. */
		expect(p.descartados).toEqual([
			expect.objectContaining({ id: `${P}-alta-v1`, codigo: 'modulo.via-desaparecida' })
		]);
	});
});
