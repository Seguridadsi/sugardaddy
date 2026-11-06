/*
 * El plan de un nodo Community con el registro, contra una base de verdad y con
 * firmas de verdad (claves de usar y tirar): sin registro, las de registro se quedan
 * fuera; con él, entran y el plan lleva la licencia para montarla; caducada, se
 * paran y cowrie sigue. Y en Cloud, su licencia las cubre. DATABASE_URL de .env; si
 * no hay, se salta.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MODULOS_REGISTRO,
	firmarDelegacion,
	firmarLicencia,
	firmarLicenciaDelegada,
	generarClaves,
	type Licencia
} from '@sugardaddy/canal';

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

const kino = generarClaves();
const panel = generarClaves();
const dias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const licencia = (l: Partial<Licencia> = {}): Licencia => ({
	tipo: 'licencia',
	version: 1,
	cliente: 'community-registro',
	nodo: 'community',
	nodoClave: 'AA==',
	modulos: [...MODULOS_REGISTRO],
	marca: 'r-plan',
	emitida: dias(-1),
	caduca: dias(300),
	...l
});
const certificado = firmarDelegacion(kino.privada, {
	tipo: 'delegacion-licencias',
	version: 1,
	msp: 'registro',
	clavePublica: panel.publica,
	modulos: [...MODULOS_REGISTRO],
	emitida: dias(-2),
	caduca: dias(400)
});
const deRegistro = (l: Partial<Licencia> = {}) =>
	firmarLicenciaDelegada(panel.privada, licencia(l), certificado);

const P = 'zz-regplan';
const SENSOR = `${P}-sensor`;

describe.skipIf(!hayBase)('el plan con el registro de Community', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, like } = await import('drizzle-orm');
	const { plan } = await import('./sensor');
	const { activar } = await import('./registro');
	const { codificarCodigo } = await import('@sugardaddy/canal');

	const guardados = new Map<string, unknown>();
	const CLAVES = ['licencia', 'registro', 'modulos', 'auto-actualizar'];
	const limpiarAjustes = async () => {
		for (const c of CLAVES) await db.delete(s.ajustes).where(eq(s.ajustes.clave, c));
	};
	const quitarTrampas = () => db.delete(s.trampas).where(like(s.trampas.id, `${P}-%`));
	const codigos = (p: Awaited<ReturnType<typeof plan>>, id: string) =>
		p.descartados.filter((d) => d.id === id).map((d) => d.codigo);
	const enElPlan = (p: Awaited<ReturnType<typeof plan>>, id: string) =>
		p.trampas.some((t) => t.id === id);

	beforeEach(async () => {
		process.env.EDICION = 'community';
		process.env.PUBLICACION_CLAVE_PUBLICA = kino.publica;
		process.env.CLAVE_SECRETOS = 'ab'.repeat(32);
		guardados.clear();
		for (const c of CLAVES) {
			const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, c));
			if (f) guardados.set(c, f.valor);
		}
		await limpiarAjustes();
		await quitarTrampas();
		await db
			.insert(s.sensores)
			.values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` })
			.onConflictDoNothing();
		const comun = {
			sensor: SENSOR,
			tipo: 'contenedor' as const,
			activo: true,
			ejecutor: 'contenedor@1',
			parametros: {}
		};
		await db.insert(s.trampas).values([
			{
				...comun,
				id: `${P}-cowrie`,
				nombre: 'ssh',
				modulo: 'cowrie',
				donde: '0.0.0.0:2222',
				via: 'contenedor'
			},
			{
				...comun,
				id: `${P}-redis`,
				nombre: 'redis',
				modulo: 'redis',
				donde: '0.0.0.0:6379',
				via: 'contenedor'
			}
		] as never);
	});
	afterEach(async () => {
		await limpiarAjustes();
		for (const [clave, valor] of guardados)
			await db.insert(s.ajustes).values({ clave, valor } as never);
	});
	afterAll(async () => {
		await quitarTrampas();
		await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
		delete process.env.EDICION;
	});

	it('sin registro: redis se queda fuera y cowrie sigue, sin licencia en el plan', async () => {
		const p = await plan(SENSOR, true);
		expect(enElPlan(p, `${P}-cowrie`)).toBe(true);
		expect(codigos(p, `${P}-redis`)).toEqual(['registro.sin']);
		expect(p.descartados.find((d) => d.id === `${P}-redis`)?.motivo).toBe(
			'this decoy is enabled for free with your registration, in Settings'
		);
		expect(p).not.toHaveProperty('licencia');
	});

	it('pegando el código: redis entra y el plan lleva la licencia para montarla', async () => {
		const f = deRegistro();
		const r = await activar(
			'admin@n.es',
			codificarCodigo({ licencia: f, token: 'a'.repeat(43), correo: 'a@b.es' })
		);
		expect(r.ok).toBe(true);
		const p = await plan(SENSOR, true);
		expect(enElPlan(p, `${P}-redis`)).toBe(true);
		expect(enElPlan(p, `${P}-cowrie`)).toBe(true);
		expect((p as { licencia?: unknown }).licencia).toEqual(f);
	});

	it('caducada: redis se para con registro.caducado y cowrie sigue', async () => {
		await db.insert(s.ajustes).values({
			clave: 'licencia',
			valor: deRegistro({ emitida: dias(-30), caduca: dias(-1) })
		} as never);
		const p = await plan(SENSOR, true);
		expect(codigos(p, `${P}-redis`)).toEqual(['registro.caducado']);
		expect(enElPlan(p, `${P}-cowrie`)).toBe(true);
	});

	it('una licencia que no es de registro no autoriza nada en Community', async () => {
		await db.insert(s.ajustes).values({
			clave: 'licencia',
			valor: firmarLicenciaDelegada(generarClaves().privada, licencia(), certificado)
		} as never);
		const p = await plan(SENSOR, true);
		expect(codigos(p, `${P}-redis`)).toEqual(['registro.sin']);
	});

	it('sin clave de publicación no se desbloquea, aunque haya licencia', async () => {
		delete process.env.PUBLICACION_CLAVE_PUBLICA;
		await db.insert(s.ajustes).values({ clave: 'licencia', valor: deRegistro() } as never);
		const p = await plan(SENSOR, true);
		expect(codigos(p, `${P}-redis`)).toEqual(['registro.sin']);
		expect(enElPlan(p, `${P}-cowrie`)).toBe(true);
	});

	it('Cloud: su licencia cubre redis; sin ella o sin nombrarla, se queda fuera con su motivo', async () => {
		delete process.env.EDICION;
		await db.insert(s.ajustes).values({ clave: 'modulos', valor: ['cowrie', 'redis'] } as never);
		await db.insert(s.ajustes).values({
			clave: 'licencia',
			valor: firmarLicencia(
				kino.privada,
				licencia({ cliente: 'acme', nodo: 'acme-1', marca: 'acme-7', modulos: ['redis'] })
			)
		} as never);
		const p = await plan(SENSOR, true);
		expect(enElPlan(p, `${P}-redis`)).toBe(true);

		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'licencia'));
		const q = await plan(SENSOR, true);
		expect(codigos(q, `${P}-redis`)).toEqual(['licencia.sin']);
		expect(enElPlan(q, `${P}-cowrie`)).toBe(true);
	});
});
