/*
 * Lo que sube la consola para el mapa público: el país de cada sensor remoto que vio una IP
 * (por la dirección desde la que llega el sensor), con sus eventos y módulos, y nunca esa
 * dirección. El sensor local y los de red privada no llevan país. Contra una base de verdad
 * (DATABASE_URL del entorno o de .env; si no hay, se salta).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let hayBase = false;
try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
hayBase = !!process.env.DATABASE_URL;
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));
/* Cada máquina de sensor, en su país; lo demás, sin país. */
vi.mock('./geo', () => ({
	geo: (ip: string) =>
		({ '4.233.112.10': { pais: 'FR' }, '20.228.171.10': { pais: 'US' } })[ip] ?? null
}));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { sensoresPorIp } = hayBase ? await import('./inteligencia') : ({} as never);
const { inArray, like } = await import('drizzle-orm');

const P = 'zz-isen';
const ATACANTE = '1.2.3.71';
const OTRO = '1.2.3.72';
const sensores = [
	{ id: `${P}-fr`, remoto: true, direccion: '4.233.112.10' },
	{ id: `${P}-us`, remoto: true, direccion: '20.228.171.10' },
	{ id: `${P}-lan`, remoto: true, direccion: '10.0.0.40' },
	{ id: `${P}-local`, remoto: false, direccion: null }
];

async function limpiar() {
	await db.delete(s.eventos).where(like(s.eventos.sensor, `${P}-%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}-%`));
}

const evento = (sensor: string, ip: string, modulo: string) => ({
	id: randomUUID(),
	sensor,
	linea: '{}',
	hash: randomUUID(),
	cuando: new Date(),
	trampa: `${P}-trampa`,
	modulo,
	tipo: 'contenedor',
	accion: 'conexion',
	severidad: 'media' as const,
	ip,
	conexionEstablecida: true
});

describe.skipIf(!hayBase)('el país de los sensores en lo que se sube', () => {
	beforeAll(async () => {
		await limpiar();
		await db
			.insert(s.sensores)
			.values(sensores.map((x) => ({ ...x, nombre: x.id, claveHash: 'x' })));
		await db
			.insert(s.eventos)
			.values([
				evento(`${P}-fr`, ATACANTE, 'redis'),
				evento(`${P}-fr`, ATACANTE, 'redis'),
				evento(`${P}-fr`, ATACANTE, 'vnc'),
				evento(`${P}-us`, ATACANTE, 'rdp'),
				evento(`${P}-lan`, ATACANTE, 'cowrie'),
				evento(`${P}-local`, ATACANTE, 'cowrie'),
				evento(`${P}-local`, OTRO, 'cowrie')
			]);
	});
	afterAll(limpiar);

	it('cuenta por país, con sus módulos, y deja fuera el local y la red privada', async () => {
		const solo = inArray(
			s.eventos.sensor,
			sensores.map((x) => x.id)
		);
		const por = await sensoresPorIp(solo, [ATACANTE, OTRO]);
		const del = [...(por.get(ATACANTE) ?? [])].sort((a, b) => a.pais.localeCompare(b.pais));
		expect(del).toEqual([
			{ pais: 'FR', eventos: 3, modulos: ['redis', 'vnc'] },
			{ pais: 'US', eventos: 1, modulos: ['rdp'] }
		]);
		expect(por.has(OTRO)).toBe(false);
		/* La dirección del sensor no sale. */
		expect(JSON.stringify([...por])).not.toMatch(/4\.233|20\.228|10\.0\.0/);
	});
});
