/*
 * El plazo de las credenciales capturadas contra una base de datos de verdad.
 * DATABASE_URL (del entorno o de .env); si no hay, se salta. Todo lo de esta
 * prueba lleva zz-credcons y es de 2020, salvo un evento reciente.
 *
 * Pasado el plazo, el sobre de un evento se cambia por la marca de caducada y
 * la contraseña en claro de antes de la 0063 se borra; la línea, el hash, la
 * máscara y la huella se quedan. Lo reciente, lo que no trae credenciales y lo
 * que el nodo guardó sin clave ('') no se tocan.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const { olvidarCredencialesAntesDe } = hayBase ? await import('./conservacion') : ({} as never);
const { CREDENCIAL_CADUCADA } = await import('./credenciales-protegidas');
const { eq, like } = await import('drizzle-orm');

const P = 'zz-credcons';
const S = `${P}-s1`;
const h = (n: number) => String(n).repeat(64).slice(0, 64);
const vieja = new Date('2020-01-10T10:00:00Z');
const reciente = new Date('2026-10-20T10:00:00Z');
const ids = {
	sobre: randomUUID(),
	antigua: randomUUID(),
	sinClave: randomUUID(),
	nada: randomUUID(),
	reciente: randomUUID()
};

const evento = (id: string, hash: string, recibido: Date, extra: Record<string, unknown>) => ({
	id,
	sensor: S,
	linea: JSON.stringify({ hashAnterior: '' }),
	hash,
	cuando: recibido,
	trampa: `${P}-t1`,
	modulo: 'cowrie',
	tipo: 'contenedor',
	accion: 'login',
	severidad: 'media' as const,
	conexionEstablecida: true,
	recibido,
	...extra
});

async function limpiar() {
	await db.delete(s.eventos).where(like(s.eventos.sensor, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
}

const fila = async (id: string) =>
	(await db.select().from(s.eventos).where(eq(s.eventos.id, id)))[0];

describe.skipIf(!hayBase)('la consola deja de guardar las credenciales pasado su plazo', () => {
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: S, nombre: S, claveHash: h(9) });
		const cred = { contrasenaMascara: 'P*****d1', contrasenaHuella: 'a'.repeat(32) };
		await db
			.insert(s.eventos)
			.values([
				evento(ids.sobre, h(1), vieja, { credencial: 'sobre-cifrado', ...cred }),
				evento(ids.antigua, h(2), vieja, { contrasena: 'Passw0rd1' }),
				evento(ids.sinClave, h(3), vieja, { credencial: '', ...cred }),
				evento(ids.nada, h(4), vieja, {}),
				evento(ids.reciente, h(5), reciente, { credencial: 'sobre-cifrado', ...cred })
			]);
	});
	afterAll(limpiar);

	it('quita el sobre y la contraseña vieja, y deja máscara, huella y hash', async () => {
		const n = await olvidarCredencialesAntesDe(new Date('2020-06-01T00:00:00Z'));
		expect(n).toBe(2);
		const sobre = await fila(ids.sobre);
		expect(sobre.credencial).toBe(CREDENCIAL_CADUCADA);
		expect(sobre.contrasenaMascara).toBe('P*****d1');
		expect(sobre.contrasenaHuella).toBe('a'.repeat(32));
		expect(sobre.hash).toBe(h(1));
		const antigua = await fila(ids.antigua);
		expect(antigua.contrasena).toBeNull();
		expect(antigua.credencial).toBe(CREDENCIAL_CADUCADA);
	});

	it('no toca lo reciente, lo guardado sin clave ni lo que no trae credenciales', async () => {
		expect((await fila(ids.reciente)).credencial).toBe('sobre-cifrado');
		expect((await fila(ids.sinClave)).credencial).toBe('');
		expect((await fila(ids.nada)).credencial).toBeNull();
	});

	it('una segunda pasada no vuelve a contar lo ya caducado', async () => {
		expect(await olvidarCredencialesAntesDe(new Date('2020-06-01T00:00:00Z'))).toBe(0);
	});
});
