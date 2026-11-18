/*
 * El estado deseado endurecido (auditoría 2026-11-14, «canal firmado»), con el latido de verdad
 * y un panel de mentira: un estado tipado hace avanzar `ultimoEmitido`; repetir uno anterior
 * no vale y no cambia nada; uno con otro tipo tampoco; y el de un panel anterior a la 0.32
 * (sin tipo) se sigue aceptando y queda contado. DATABASE_URL (del entorno o de .env); si no
 * hay, se salta. Prefijo zz-cest.
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

const CLIENTE = 'zz-cest-cliente';
const NODO = 'zz-cest-nodo';
const panel = generarClaves();
const nodo = generarClaves();

/* Sin base, ni se importan: db.ts lanza sin DATABASE_URL. */
const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { latir } = hayBase ? await import('./canal') : ({} as never);
const { eq, inArray } = await import('drizzle-orm');

describe.skipIf(!hayBase)('el estado deseado: tipo, emitido y repeticiones', () => {
	const estado = (emitido: number, cambios: Partial<EstadoDeseado> = {}): EstadoDeseado => ({
		version: 1,
		tipo: 'estado',
		cliente: CLIENTE,
		versionObjetivo: '0.0.1',
		release: null,
		anillo: 'general',
		despliegueEnPausa: false,
		soporte: null,
		modulos: [],
		emitido: new Date(emitido).toISOString(),
		caduca: new Date(emitido + 3600_000).toISOString(),
		...cambios
	});
	/* Lo que responde el panel de mentira al próximo latido. */
	let respuesta: unknown = null;
	const panelDeMentira = async (url: string | URL | Request) => {
		const ruta = new URL(String(url)).pathname;
		if (ruta === '/api/nodo/latido') return Response.json(respuesta);
		return new Response('{}', { status: 202 });
	};

	type Canal = {
		estado: EstadoDeseado | null;
		error: string | null;
		ultimoEmitido?: string | null;
		firmasAntiguas?: { estado?: string };
	};
	const canal = async () => {
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
		return f.valor as Canal;
	};
	const limpiar = async () => {
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, ['canal']));
		await borrarAuditoriaDePrueba(db, eq(s.auditoria.quien, `node ${NODO}`));
	};

	beforeEach(async () => {
		await limpiar();
		await db.insert(s.ajustes).values({
			clave: 'canal',
			valor: {
				panel: 'http://localhost:9',
				nodo: NODO,
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
		vi.stubGlobal('fetch', panelDeMentira);
	});
	afterEach(() => vi.unstubAllGlobals());
	afterAll(limpiar);

	const ahora = Date.now();

	it('un estado tipado se acepta y deja su emitido como último', async () => {
		respuesta = firmarEstado(panel.privada, estado(ahora - 60_000));
		await latir();
		const c = await canal();
		expect(c.estado?.tipo).toBe('estado');
		expect(c.ultimoEmitido).toBe(new Date(ahora - 60_000).toISOString());
		expect(c.firmasAntiguas).toBeUndefined();
	});

	it('repetir un estado anterior no vale: ni cambia el estado ni el último emitido', async () => {
		respuesta = firmarEstado(panel.privada, estado(ahora - 60_000, { modulos: ['cowrie'] }));
		await latir();
		const viejo = firmarEstado(panel.privada, estado(ahora - 20 * 60_000, { modulos: ['rdp'] }));
		respuesta = viejo;
		await latir();
		const c = await canal();
		expect(c.error).toMatch(/older than the last one accepted/);
		expect(c.estado?.modulos).toEqual(['cowrie']);
		expect(c.ultimoEmitido).toBe(new Date(ahora - 60_000).toISOString());
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.quien, `node ${NODO}`));
		expect(a).toMatchObject({ accion: 'desired state rejected' });
	});

	it('el mismo estado otra vez sí vale (el panel reutiliza firmas)', async () => {
		respuesta = firmarEstado(panel.privada, estado(ahora - 60_000));
		await latir();
		await latir();
		expect((await canal()).error).toBeNull();
	});

	it('con otro tipo no vale', async () => {
		respuesta = firmarEstado(
			panel.privada,
			estado(ahora, { tipo: 'global' } as unknown as Partial<EstadoDeseado>)
		);
		await latir();
		const c = await canal();
		expect(c.error).toMatch(/not a desired state/);
		expect(c.estado).toBeNull();
	});

	it('compatibilidad: el estado sin tipo de un panel anterior se acepta y se cuenta', async () => {
		const { tipo: _t, ...sinTipo } = estado(ahora - 60_000);
		respuesta = firmarEstado(panel.privada, sinTipo as EstadoDeseado);
		await latir();
		const c = await canal();
		expect(c.error).toBeNull();
		expect(c.estado?.cliente).toBe(CLIENTE);
		expect(c.firmasAntiguas?.estado).toBeTruthy();
		/* No hace avanzar el último emitido: el panel anterior puede mandar uno más viejo. */
		expect(c.ultimoEmitido ?? null).toBeNull();
		const { tipo: _t2, ...masViejo } = estado(ahora - 20 * 60_000);
		respuesta = firmarEstado(panel.privada, masViejo as EstadoDeseado);
		await latir();
		expect((await canal()).error).toBeNull();
	});

	it('pero un estado sin tipo anterior al último tipado no vale', async () => {
		respuesta = firmarEstado(panel.privada, estado(ahora - 60_000));
		await latir();
		const { tipo: _t, ...viejo } = estado(ahora - 20 * 60_000);
		respuesta = firmarEstado(panel.privada, viejo as EstadoDeseado);
		await latir();
		expect((await canal()).error).toMatch(/older than the last one accepted/);
	});
});
