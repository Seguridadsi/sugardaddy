/*
 * El candado de licencia en el plan (capa 4, docs/diseno/licencias-de-pago.md):
 * una trampa de PAGO solo entra en el plan si hay una licencia válida que la
 * incluya; sin ella o caducada, sale descartada con licencia.sin / licencia.caducada.
 * Las trampas GRATIS no se tocan. El catálogo usa el mismo candado: una de pago
 * que la licencia no cubre no se ofrece para desplegar. Contra una base de datos
 * de verdad, como plan-base.spec.ts: DATABASE_URL de .env; si no hay, se salta.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { firmarLicencia, generarClaves, type Licencia } from '@sugardaddy/canal';

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
/* El panel autoriza una de pago (mysql) y una gratis (cowrie). */
vi.mock('./catalogo', async (original) => {
	const catalogo = await original<typeof import('./catalogo')>();
	return {
		...catalogo,
		autorizados: async () => ['mysql', 'cowrie'],
		trampasAutorizadas: async () =>
			catalogo.honeycosas().filter((h) => h.id === 'mysql' || h.id === 'cowrie')
	};
});

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { plan } = hayBase ? await import('./sensor') : ({} as never);
const { coberturaLicencia } = hayBase ? await import('./candado') : ({} as never);
const { porQueNo } = hayBase ? await import('./catalogo') : ({} as never);
const { eq, like } = await import('drizzle-orm');

const P = 'zz-pl';
const SENSOR = `${P}-s1`;
const kino = generarClaves();
const nodo = generarClaves();

const licencia = (cambios: Partial<Licencia> = {}): Licencia => ({
	tipo: 'licencia',
	version: 1,
	cliente: 'zz-cliente',
	nodo: 'zz-nodo',
	nodoClave: nodo.publica,
	modulos: ['mysql'],
	marca: 'zz-marca',
	emitida: '2026-10-20T09:00:00.000Z',
	caduca: '2099-01-01T00:00:00.000Z',
	...cambios
});

async function guardarLic(l: Licencia | null) {
	if (l === null) {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'licencia'));
		return;
	}
	const f = firmarLicencia(kino.privada, l);
	await db
		.insert(s.ajustes)
		.values({ clave: 'licencia', valor: f })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: f } });
}

async function limpiar() {
	await db.delete(s.trampas).where(like(s.trampas.id, `${P}%`));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'licencia'));
}

const codigos = (p: { descartados: { id: string; codigo: string }[] }, id: string) =>
	p.descartados.filter((d) => d.id === id).map((d) => d.codigo);

describe.skipIf(!hayBase)('el candado de licencia en el plan', () => {
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		const comun = { sensor: SENSOR, tipo: 'contenedor' as const };
		await db.insert(s.trampas).values([
			{
				...comun,
				id: `${P}-mysql`,
				nombre: 'bd',
				modulo: 'mysql',
				donde: '0.0.0.0:33306',
				parametros: { puertoMysql: 33306, version: '8.0', usuarioCebo: 'svc_backup' }
			},
			{
				...comun,
				id: `${P}-ssh`,
				nombre: 'ssh',
				modulo: 'cowrie',
				donde: '0.0.0.0:2222',
				parametros: {}
			}
		]);
		process.env.PUBLICACION_CLAVE_PUBLICA = kino.publica;
	});
	beforeEach(async () => {
		process.env.PUBLICACION_CLAVE_PUBLICA = kino.publica;
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('sin licencia, la de pago se descarta con licencia.sin y la gratis sigue', async () => {
		await guardarLic(null);
		const p = await plan(SENSOR, true, '0.13.1');
		expect(codigos(p, `${P}-mysql`)).toEqual(['licencia.sin']);
		expect(p.trampas.map((t) => t.id)).toContain(`${P}-ssh`);
		expect(codigos(p, `${P}-ssh`)).toEqual([]);
	});

	it('con licencia válida que la incluye, la de pago entra en el plan', async () => {
		await guardarLic(licencia());
		const p = await plan(SENSOR, true, '0.13.1');
		expect(p.trampas.map((t) => t.id).sort()).toEqual([`${P}-mysql`, `${P}-ssh`]);
		expect(codigos(p, `${P}-mysql`)).toEqual([]);
		/* La licencia viaja en el plan para que el sensor la monte. */
		expect(p.licencia).toMatchObject({ firma: expect.any(String) });
	});

	it('con licencia caducada, la de pago se descarta con licencia.caducada', async () => {
		await guardarLic(licencia({ caduca: '2020-01-01T00:00:00.000Z' }));
		const p = await plan(SENSOR, true, '0.13.1');
		expect(codigos(p, `${P}-mysql`)).toEqual(['licencia.caducada']);
		expect(p.trampas.map((t) => t.id)).toContain(`${P}-ssh`);
	});

	it('con licencia válida que NO incluye la de pago, se descarta con licencia.sin', async () => {
		await guardarLic(licencia({ modulos: ['postgresql'] }));
		const p = await plan(SENSOR, true, '0.13.1');
		expect(codigos(p, `${P}-mysql`)).toEqual(['licencia.sin']);
	});

	it('sin clave de publicación para cotejar, no se descarta por licencia (lo hará la trampa)', async () => {
		await guardarLic(null);
		delete process.env.PUBLICACION_CLAVE_PUBLICA;
		const p = await plan(SENSOR, true, '0.13.1');
		expect(codigos(p, `${P}-mysql`)).not.toContain('licencia.sin');
	});
});

describe.skipIf(!hayBase)('el mismo candado en el catálogo', () => {
	beforeEach(() => {
		process.env.PUBLICACION_CLAVE_PUBLICA = kino.publica;
	});
	afterAll(async () => {
		if (hayBase) await guardarLic(null);
	});

	it('una de pago sin licencia no se ofrece; con una licencia que la incluye, sí', async () => {
		await guardarLic(null);
		let cubre = await coberturaLicencia();
		expect(cubre('mysql')).toBe('licencia.sin');
		expect(cubre('cowrie')).toBe('cubierta');
		expect(porQueNo({ incluida: true, licencia: cubre('mysql') })).toBe(
			'De pago: no está en tu licencia'
		);

		await guardarLic(licencia());
		cubre = await coberturaLicencia();
		expect(cubre('mysql')).toBe('cubierta');
		expect(cubre('postgresql')).toBe('licencia.sin');
		expect(porQueNo({ incluida: true, licencia: cubre('mysql') })).toBeNull();
	});

	it('con la licencia caducada, ninguna de pago', async () => {
		await guardarLic(licencia({ caduca: '2020-01-01T00:00:00.000Z' }));
		const cubre = await coberturaLicencia();
		expect(cubre('mysql')).toBe('licencia.caducada');
		expect(porQueNo({ incluida: true, licencia: cubre('mysql') })).toBe(
			'De pago: tu licencia ha caducado'
		);
	});

	it('fuera de la suscripción no se ofrece aunque la licencia la cubra', () => {
		expect(porQueNo({ incluida: false, licencia: 'cubierta' })).toBe(
			'No incluida en tu suscripción'
		);
	});
});
