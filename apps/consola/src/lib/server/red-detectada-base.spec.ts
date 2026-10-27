/*
 * La red que cuenta el instalador de un sensor remoto (POST /api/sensor/red),
 * por la ruta de verdad. Contra una base de datos de verdad (DATABASE_URL de
 * .env, como capacidades.spec.ts); si no hay, se salta.
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
const { cambiarRed, crearSensor } = hayBase ? await import('./gestion') : ({} as never);
const rutaRed = hayBase ? await import('../../routes/api/sensor/red/+server') : null;
const { eq, like, or } = await import('drizzle-orm');

const QUIEN = 'zz-prueba-red';
/* Todo lo de esta prueba empieza por zz-red: así se limpia sin tocar nada más. */
const P = 'zz-red';
let token = '';

async function limpiar() {
	await db.delete(s.destinos).where(like(s.destinos.id, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
	await db
		.delete(s.auditoria)
		.where(or(eq(s.auditoria.quien, QUIEN), like(s.auditoria.quien, `sensor ${P}%`)));
}

/* POST /api/sensor/red, como lo manda el instalador. */
const contar = async (cuerpo: unknown, t = token) => {
	const r = await rutaRed!.POST({
		request: new Request('http://consola/api/sensor/red', {
			method: 'POST',
			headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
			body: JSON.stringify(cuerpo)
		})
	} as never);
	return r.json();
};

const red = async () =>
	(
		await db
			.select({ red: s.sensores.red, vlan: s.sensores.vlan })
			.from(s.sensores)
			.where(eq(s.sensores.id, `${P}-sevilla`))
	)[0];

describe.skipIf(!hayBase)('la red que cuenta el instalador de un sensor remoto', () => {
	beforeAll(async () => {
		await limpiar();
		token = (await crearSensor(QUIEN, {
			id: `${P}-sevilla`,
			nombre: 'Planta de Sevilla',
			red: null,
			vlan: null,
			remoto: true
		}))!;
	});
	afterAll(limpiar);

	it('lo que no se entiende no se guarda, y no es un error', async () => {
		expect(await contar({ red: 'eth0', vlan: '9999' })).toEqual({ guardada: false });
		expect(await contar(null)).toEqual({ guardada: false });
		expect(await red()).toEqual({ red: null, vlan: null });
	});

	it('se guarda con la dirección de la red, y queda en los logs', async () => {
		expect(await contar({ red: '10.70.0.9/24', vlan: '70' })).toEqual({ guardada: true });
		expect(await red()).toEqual({ red: '10.70.0.0/24', vlan: 70 });
		const [l] = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.quien, `sensor ${P}-sevilla`));
		expect(l).toMatchObject({
			accion: 'red del sensor detectada',
			detalle: { id: `${P}-sevilla`, red: '10.70.0.0/24', vlan: 70 }
		});
	});

	it('lo que ya tiene el sensor no se toca: lo escrito en Sensores manda', async () => {
		expect(await contar({ red: '192.168.1.0/24', vlan: '' })).toEqual({ guardada: false });
		await cambiarRed(QUIEN, `${P}-sevilla`, { red: '10.80.0.0/24', vlan: null });
		expect(await contar({ red: '10.70.0.0/24', vlan: '70' })).toEqual({ guardada: false });
		expect(await red()).toEqual({ red: '10.80.0.0/24', vlan: null });
	});

	it('sin el token del sensor, 401', async () => {
		await expect(contar({ red: '10.70.0.0/24' }, 'x'.repeat(43))).rejects.toMatchObject({
			status: 401
		});
	});
});
