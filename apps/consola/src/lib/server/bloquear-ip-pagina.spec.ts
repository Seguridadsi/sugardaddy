/*
 * La acción «Bloquear esta IP» del perfil de IP (routes/events/ip/[ip]): mete
 * la IP en la lista negra local (la que alimenta el EDL), con la caducidad que
 * se elija, reusando anadirALista. Contra una base de datos de verdad
 * (DATABASE_URL de .env, como edl.spec.ts); si no hay, se salta.
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
const ruta = hayBase ? await import('../../routes/events/ip/[ip]/+page.server') : null;
const { eq } = await import('drizzle-orm');

const QUIEN = 'zz-bloquear-ip';

const locals = (roles = ['admin']) => ({
	usuario: { nombre: 'Prueba', correo: QUIEN, roles },
	modoDesarrollo: false
});

const peticion = (campos: Record<string, string> = {}) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos)) f.set(k, v);
	return new Request('http://consola/events/ip', { method: 'POST', body: f });
};

async function bloquear(ip: string, campos: Record<string, string> = {}, roles?: string[]) {
	try {
		return await ruta!.actions.bloquear({
			params: { ip },
			request: peticion(campos),
			locals: locals(roles)
		} as never);
	} catch (e) {
		return e;
	}
}

const negraDe = async (valor: string) =>
	db.select().from(s.listas).where(eq(s.listas.valor, valor));

describe.skipIf(!hayBase)('perfil de IP: «Bloquear esta IP»', () => {
	beforeAll(async () => {
		await db.delete(s.listas).where(eq(s.listas.quien, QUIEN));
	});
	afterAll(async () => {
		if (hayBase) await db.delete(s.listas).where(eq(s.listas.quien, QUIEN));
	});

	it('mete la IP en la lista negra local con caducidad y la segunda vez dice que ya estaba', async () => {
		const ip = '198.51.100.77';
		const r = await bloquear(ip, { dias: '7' });
		expect(r).toEqual({ bloqueada: ip });
		const [fila] = await negraDe(ip);
		expect(fila).toMatchObject({
			valor: ip,
			clase: 'ip',
			lista: 'negra',
			ambito: 'local',
			quien: QUIEN
		});
		/* caduca ≈ dentro de 7 días. */
		const dentro = fila.caduca!.getTime() - Date.now();
		expect(dentro).toBeGreaterThan(6.9 * 86_400_000);
		expect(dentro).toBeLessThan(7.1 * 86_400_000);

		/* La misma IP otra vez no duplica. */
		expect(await bloquear(ip, { dias: '7' })).toEqual({ yaEstaba: true });
		expect(await negraDe(ip)).toHaveLength(1);
	});

	it('sin días, el bloqueo no caduca', async () => {
		const ip = '198.51.100.78';
		expect(await bloquear(ip, { dias: '0' })).toEqual({ bloqueada: ip });
		const [fila] = await negraDe(ip);
		expect(fila.caduca).toBeNull();
	});

	it('quien no puede tocar listas no bloquea', async () => {
		const r = await bloquear('198.51.100.79', { dias: '0' }, ['lector']);
		expect(r).toMatchObject({ status: 403 });
		expect(await negraDe('198.51.100.79')).toEqual([]);
	});

	it('un valor que no es una IP se rechaza', async () => {
		const r = await bloquear('no-es-ip', { dias: '0' });
		expect(r).toMatchObject({ status: 400 });
	});
});
