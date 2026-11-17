/*
 * El latido mínimo (Ajustes → Central, docs/seguridad/flujo-de-datos.md), con el latido de
 * verdad y un panel de mentira: de serie va completo; con el mínimo, solo lo que hace falta
 * para la licencia y las actualizaciones, sin cifras ni diagnósticos; y queda en la auditoría.
 * DATABASE_URL (del entorno o de .env); si no hay, se salta. Prefijo zz-lmin.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firmarEstado, generarClaves, type EstadoDeseado } from '@sugardaddy/canal';
import { borrarAuditoriaDePrueba } from './db/pruebas-auditoria';

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

const CLIENTE = 'zz-lmin-cliente';
const QUIEN = 'zz-lmin@prueba';
const panel = generarClaves();
const nodo = generarClaves();

/* Lo único que puede llevar un latido mínimo. */
const PERMITIDOS = [
	'version',
	'minimo',
	'comparticion',
	'actualizacion',
	'soporte',
	'clavesPanel',
	'ordenPanel',
	'vigilancia',
	'marca',
	'configuracion'
];

describe.skipIf(!hayBase)('el latido mínimo', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, inArray } = await import('drizzle-orm');
	const { latir } = await import('./canal');
	const { guardarLatidoMinimo, latidoMinimo } = await import('./consultas');

	let cuerpos: Record<string, unknown>[] = [];
	const estado = (): EstadoDeseado => ({
		version: 1,
		cliente: CLIENTE,
		versionObjetivo: '0.0.1',
		release: null,
		anillo: 'general',
		despliegueEnPausa: false,
		soporte: null,
		modulos: [],
		emitido: new Date().toISOString(),
		caduca: new Date(Date.now() + 600_000).toISOString()
	});
	const panelDeMentira = async (url: string | URL | Request, init?: RequestInit) => {
		const ruta = new URL(String(url)).pathname;
		if (ruta === '/api/nodo/latido') {
			cuerpos.push(JSON.parse(String(init?.body ?? '{}')));
			return new Response(JSON.stringify(firmarEstado(panel.privada, estado())), { status: 200 });
		}
		return new Response('{}', { status: 202 });
	};

	const SENSOR = 'zz-lmin-sensor';
	const limpiar = async () => {
		await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, ['canal', 'latido-minimo']));
		await borrarAuditoriaDePrueba(db, eq(s.auditoria.quien, QUIEN));
	};

	beforeEach(async () => {
		await limpiar();
		await db.insert(s.ajustes).values({
			clave: 'canal',
			valor: {
				panel: 'http://localhost:9',
				nodo: 'zz-lmin-nodo',
				cliente: CLIENTE,
				clavePrivada: nodo.privada,
				clavePublica: nodo.publica,
				clavePublicaPanel: panel.publica,
				cortado: false,
				ultimoContacto: null,
				error: null,
				estado: null
			}
		});
		cuerpos = [];
		vi.stubGlobal('fetch', panelDeMentira);
	});
	afterEach(() => vi.unstubAllGlobals());
	afterAll(limpiar);

	it('de serie va completo, con las cifras', async () => {
		expect(await latidoMinimo()).toBe(false);
		await latir();
		const l = cuerpos.at(-1)!;
		expect(l).not.toHaveProperty('minimo');
		expect(l).toHaveProperty('sensores');
		expect(l).toHaveProperty('trampas');
		expect(l).toHaveProperty('eventos24h');
		expect(l).toHaveProperty('acceso');
	});

	it('con el mínimo, solo lo de la licencia y las actualizaciones', async () => {
		await guardarLatidoMinimo(QUIEN, true);
		await latir();
		const l = cuerpos.at(-1)!;
		expect(l.minimo).toBe(true);
		expect(Object.keys(l).filter((k) => !PERMITIDOS.includes(k))).toEqual([]);
		expect(l).toHaveProperty('version');
		expect(l).toHaveProperty('actualizacion');
		expect(l).toHaveProperty('comparticion');
		expect(l).toHaveProperty('soporte');
		const [a] = await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
		expect(a).toMatchObject({ accion: 'minimal heartbeat', detalle: { activo: true } });
	});

	it('el disco de datos del appliance va en el completo y no en el mínimo', async () => {
		await db.insert(s.sensores).values({
			id: SENSOR,
			nombre: SENSOR,
			claveHash: `x-${SENSOR}`,
			ultimoLatido: new Date(),
			capacidades: {
				hechos: {
					'disco.cifrado': { valor: true },
					'disco.tpm': { valor: false, motivo: 'tpm.ausente' },
					'integridad.aide': { valor: true }
				}
			} as never
		});
		await latir();
		expect(cuerpos.at(-1)?.disco).toEqual({ cifrado: true, tpm: false });
		await guardarLatidoMinimo(QUIEN, true);
		await latir();
		expect(cuerpos.at(-1)).not.toHaveProperty('disco');
	});

	it('al apagarlo vuelve el completo', async () => {
		await guardarLatidoMinimo(QUIEN, true);
		await guardarLatidoMinimo(QUIEN, false);
		await latir();
		expect(cuerpos.at(-1)).toHaveProperty('eventos24h');
	});
});
