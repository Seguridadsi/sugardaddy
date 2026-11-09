/*
 * CON-8 del análisis de seguridad (docs/seguridad): el secreto con el que el
 * webhook de eventos firma cada envío se guarda cifrado con la clave del nodo
 * y se sigue leyendo el de antes, en claro. El envío no sigue redirecciones.
 * Contra una base de verdad (DATABASE_URL) y con CLAVE_SECRETOS; si no, se salta.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
const hayBase = !!process.env.DATABASE_URL && !!process.env.CLAVE_SECRETOS;

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const c = hayBase ? await import('./consultas') : ({} as never);
const { cifrar } = hayBase ? await import('./secretos') : ({} as never);
const { eq, inArray } = await import('drizzle-orm');

const CLAVES = ['webhook', 'webhook-pos', 'webhook-fallo'];
const EVENTO = '7c0e2a4e-1b1d-4f8e-9a51-0e3c3d0f5a11';

describe.skipIf(!hayBase)('secreto del webhook de eventos (CON-8)', () => {
	let previos: (typeof s.ajustes.$inferSelect)[] = [];

	beforeAll(async () => {
		previos = await db.select().from(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
	});

	afterAll(async () => {
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		for (const p of previos) await db.insert(s.ajustes).values(p);
	});

	it('cifrado en la base, legible para firmar; el de antes en claro también', async () => {
		await c.guardarWebhook('prueba', {
			url: 'https://siem.example/x',
			activo: false,
			secreto: null,
			secretoCifrado: cifrar({ secreto: 'firma-de-prueba-0123456789' }, 'webhook')
		});
		const [fila] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'webhook'));
		expect(JSON.stringify(fila.valor)).not.toContain('firma-de-prueba');
		expect(c.secretoWebhook(await c.webhook())).toBe('firma-de-prueba-0123456789');

		expect(
			c.secretoWebhook({
				url: null,
				activo: false,
				secreto: 'viejo-en-claro',
				secretoCifrado: null
			})
		).toBe('viejo-en-claro');
		/* Cifrado para otra cosa (otro contexto): no se lee. */
		expect(
			c.secretoWebhook({
				url: null,
				activo: false,
				secreto: null,
				secretoCifrado: cifrar({ secreto: 'x' }, 'salida:otra')
			})
		).toBe(null);
	});

	it('Ajustes: sin clave del nodo, guardar o apagar no falla ni pierde el secreto de antes', async () => {
		const ruta = await import('../../routes/settings/+page.server');
		const guardar = async (campos: Record<string, string>) => {
			const f = new FormData();
			for (const [k, v] of Object.entries(campos)) f.append(k, v);
			return (ruta.actions as Record<string, (e: unknown) => Promise<unknown>>).webhook({
				request: new Request('http://consola/settings', { method: 'POST', body: f }),
				locals: { usuario: { nombre: 'p', correo: 'p@ejemplo.com', roles: ['admin'] } }
			});
		};
		await c.guardarWebhook('prueba', {
			url: 'https://siem.example/x',
			activo: true,
			secreto: 'viejo-en-claro',
			secretoCifrado: null
		});
		const clave = process.env.CLAVE_SECRETOS;
		delete process.env.CLAVE_SECRETOS;
		try {
			expect(await guardar({ url: 'https://siem.example/x' })).toEqual({
				mensaje: 'Webhook disabled.'
			});
			expect(await c.webhook()).toMatchObject({ secreto: 'viejo-en-claro', activo: false });
		} finally {
			process.env.CLAVE_SECRETOS = clave;
		}
		/* Con clave, el de antes se cifra al guardar. */
		await guardar({ url: 'https://siem.example/x' });
		const w = await c.webhook();
		expect(w.secreto).toBeNull();
		expect(c.secretoWebhook(w)).toBe('viejo-en-claro');
	});

	it('una redirección del receptor no se sigue y no avanza la marca de agua', async () => {
		let pedidas = 0;
		/* /eventos redirige a /otra, en el mismo servidor, que sí lo aceptaría. */
		const srv = createServer((req, res) => {
			pedidas++;
			if (req.url === '/otra') res.writeHead(200).end();
			else res.writeHead(307, { location: '/otra' }).end();
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		const puerto = (srv.address() as AddressInfo).port;
		try {
			await c.guardarWebhook('prueba', {
				url: `http://127.0.0.1:${puerto}/eventos`,
				activo: true,
				secreto: null,
				secretoCifrado: null
			});
			/* Un evento recién llegado, después de la marca de agua. */
			const pos = { recibido: new Date(Date.now() - 60_000).toISOString(), id: '' };
			await c.guardarWebhookPos(pos);
			await db
				.insert(s.sensores)
				.values({ id: 'zz-webhook', nombre: 'Sensor webhook', claveHash: 'x' })
				.onConflictDoNothing();
			await db.insert(s.eventos).values({
				id: EVENTO,
				sensor: 'zz-webhook',
				linea: '{"prueba":1}',
				hash: '0'.repeat(64),
				cuando: new Date(),
				trampa: 'zz-webhook-t',
				modulo: 'cowrie',
				tipo: 'contenedor',
				accion: 'conexion',
				severidad: 'baja',
				conexionEstablecida: true
			});
			const { enviarWebhookPendientes } = await import('./webhook');
			await enviarWebhookPendientes();
			expect(pedidas).toBe(1);
			expect(await c.webhookPos()).toEqual(pos);
			/* Y queda dicho, para Ajustes. */
			expect((await c.falloWebhook())?.detalle).toMatch(
				/HTTP 307: the receiver redirects to \/otra/
			);
		} finally {
			srv.close();
			await db.delete(s.eventos).where(eq(s.eventos.id, EVENTO));
			await db.delete(s.sensores).where(eq(s.sensores.id, 'zz-webhook'));
		}
	});
});
