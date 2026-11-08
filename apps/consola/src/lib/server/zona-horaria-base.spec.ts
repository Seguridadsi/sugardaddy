/*
 * La zona horaria de cada persona contra una base de datos de verdad.
 * DATABASE_URL (del entorno o de .env); si no hay, se salta. Filas con oid zz-zona.
 */
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
const m = hayBase ? await import('./zona-horaria') : ({} as never);
const { inArray } = await import('drizzle-orm');

describe.skipIf(!hayBase)('la zona horaria de cada persona', () => {
	const OIDS = [
		'local:zz-zona-a',
		'zz-zona-1111-entra',
		'emergencia:zz-zona',
		'zz-zona-dev@localhost',
		'local:zz-zona-otro'
	];
	const local = { correo: 'zz-a@ejemplo.test', oid: OIDS[0] };
	const entra = { correo: 'zz-b@ejemplo.test', oid: OIDS[1] };
	const emergencia = { correo: 'zz-c@ejemplo.test', oid: OIDS[2] };
	const desarrollo = { correo: OIDS[3] };
	const sinCookie = { get: () => undefined };
	const cookie = (valor: string) => ({ get: () => valor });

	const limpiar = () =>
		db.delete(s.preferenciasUsuario).where(inArray(s.preferenciasUsuario.oid, OIDS));

	beforeAll(limpiar);
	afterAll(limpiar);

	it('sin elegir nada: Madrid, hasta que el navegador dice la suya', async () => {
		expect(await m.zonasDe(entra, sinCookie)).toEqual({
			zonaHoraria: 'Europe/Madrid',
			zonaGuardada: null,
			zonaNavegador: 'Europe/Madrid'
		});
		expect(await m.zonasDe(entra, cookie('Atlantic/Canary'))).toEqual({
			zonaHoraria: 'Atlantic/Canary',
			zonaGuardada: null,
			zonaNavegador: 'Atlantic/Canary'
		});
	});

	it('la cookie la escribe cualquiera: si no es una zona, como si no estuviera', async () => {
		for (const mala of ['Marte/Olimpo', '<script>', '+01:00', ''])
			expect((await m.zonasDe(entra, cookie(mala))).zonaHoraria).toBe('Europe/Madrid');
	});

	it('la elegida manda sobre la del navegador, que se sigue sabiendo', async () => {
		await m.guardarZona(entra, 'America/Mexico_City');
		expect(await m.zonasDe(entra, cookie('Atlantic/Canary'))).toEqual({
			zonaHoraria: 'America/Mexico_City',
			zonaGuardada: 'America/Mexico_City',
			zonaNavegador: 'Atlantic/Canary'
		});
	});

	it('cada uno la suya: local, Entra, emergencia y el usuario de desarrollo', async () => {
		await m.guardarZona(local, 'Asia/Tokyo');
		await m.guardarZona(entra, 'America/Mexico_City');
		await m.guardarZona(emergencia, 'UTC');
		await m.guardarZona(desarrollo, 'Europe/London');
		expect((await m.zonasDe(local, sinCookie)).zonaHoraria).toBe('Asia/Tokyo');
		expect((await m.zonasDe(entra, sinCookie)).zonaHoraria).toBe('America/Mexico_City');
		expect((await m.zonasDe(emergencia, sinCookie)).zonaHoraria).toBe('UTC');
		expect((await m.zonasDe(desarrollo, sinCookie)).zonaHoraria).toBe('Europe/London');
	});

	it('quien no ha entrado no tiene zona guardada, aunque se le parezca', async () => {
		expect((await m.zonasDe(null, cookie('Atlantic/Canary'))).zonaGuardada).toBeNull();
	});

	it('cambiarla sustituye a la anterior, y sin zona vuelve a la del navegador', async () => {
		await m.guardarZona(local, 'Asia/Seoul');
		expect((await m.zonasDe(local, sinCookie)).zonaHoraria).toBe('Asia/Seoul');
		await m.guardarZona(local, null);
		expect(await m.zonasDe(local, cookie('Atlantic/Canary'))).toMatchObject({
			zonaHoraria: 'Atlantic/Canary',
			zonaGuardada: null
		});
	});

	it('una guardada que el sistema ya no conoce no rompe nada', async () => {
		await db.insert(s.preferenciasUsuario).values({ oid: OIDS[4], zonaHoraria: 'Marte/Olimpo' });
		expect(await m.zonasDe({ correo: 'x@y.test', oid: OIDS[4] }, cookie('UTC'))).toEqual({
			zonaHoraria: 'UTC',
			zonaGuardada: null,
			zonaNavegador: 'UTC'
		});
	});
});
