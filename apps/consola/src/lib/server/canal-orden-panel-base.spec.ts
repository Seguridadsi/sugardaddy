/*
 * La dirección del panel por orden firmada (docs/administrador/panel/perder-la-region.md): el
 * nodo solo cambia de panel con una orden firmada con una clave de publicación de uso
 * delegaciones, vigente, para el panel en el que está y más nueva que la aplicada; con el panel
 * callado, la busca en el repo público. DATABASE_URL (del entorno o de .env); si no hay, se salta.
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	firmanteDePrivada,
	firmarCon,
	generarClaves,
	huella,
	type OrdenPanel
} from '@sugardaddy/canal';

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

const publicacion = generarClaves();
const ajena = generarClaves();
const panelViejo = generarClaves();
const nodo = generarClaves();
const hsmNuevo = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	.publicKey.export({ format: 'der', type: 'spki' })
	.toString('base64');
const VIEJO = 'https://sugardaddy-central.azurewebsites.net';
const NUEVO = 'https://panel-dr.neutro.example';
const AHORA = Date.parse('2026-11-20T00:00:00.000Z');
const orden = (o: Partial<OrdenPanel> = {}): OrdenPanel => ({
	tipo: 'panel',
	version: 1,
	direccion: NUEVO,
	antes: ['sugardaddy-central.azurewebsites.net'],
	desde: '2026-11-15T00:00:00.000Z',
	caduca: '2026-12-15T00:00:00.000Z',
	emitida: '2026-11-15T00:00:00.000Z',
	...o
});
const firmar = (o: OrdenPanel, con = publicacion.privada) => {
	const texto = JSON.stringify(o);
	return { orden: texto, ...firmarCon(texto, firmanteDePrivada(con)) };
};
const CLAVES = ['canal', 'panel-orden', 'panel-orden-mala'];

describe.skipIf(!hayBase)('la dirección del panel por orden firmada', async () => {
	const { db, schema: s } = await import('./db');
	const { inArray } = await import('drizzle-orm');
	const { aplicarOrdenPanel, buscarOrdenPanel, estadoCanal, _olvidarBusquedaOrdenPanel } =
		await import('./canal');

	const fijar = (extra: Record<string, unknown> = {}) =>
		db.insert(s.ajustes).values({
			clave: 'canal',
			valor: {
				panel: VIEJO,
				nodo: 'zz-op-nodo',
				cliente: 'zz-op',
				clavePrivada: nodo.privada,
				clavePublica: nodo.publica,
				clavePublicaPanel: panelViejo.publica,
				cortado: false,
				ultimoContacto: null,
				error: null,
				estado: null,
				...extra
			}
		});
	const panel = async () => (await estadoCanal())!.panel;
	const limpiar = async () => {
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
	};

	beforeEach(async () => {
		process.env.PUBLICACION_CLAVES = `delegaciones:${publicacion.publica}`;
		process.env.PUBLICACION_CLAVE_PUBLICA = '';
		await limpiar();
	});
	afterEach(() => vi.unstubAllGlobals());
	afterAll(async () => {
		await limpiar();
		delete process.env.PUBLICACION_CLAVES;
		delete process.env.PUBLICACION_CLAVE_PUBLICA;
	});

	it('firmada, vigente y para su panel: cambia de dirección y lo dice', async () => {
		await fijar();
		expect(await aplicarOrdenPanel(firmar(orden()), 'estatica', AHORA)).toBe('aplicada');
		expect(await panel()).toBe(NUEVO);
		expect((await estadoCanal())!.ordenPanel).toMatchObject({
			direccion: NUEVO,
			antes: VIEJO,
			origen: 'estatica'
		});
	});

	it('con otra clave, caducada, aún no vigente o de otro panel: no cambia nada', async () => {
		await fijar();
		expect(await aplicarOrdenPanel(firmar(orden(), ajena.privada), 'estatica', AHORA)).toBe(
			'rechazada'
		);
		expect(
			await aplicarOrdenPanel(firmar(orden()), 'estatica', Date.parse('2026-12-16T00:00:00Z'))
		).toBe('no-aplica');
		expect(
			await aplicarOrdenPanel(firmar(orden()), 'estatica', Date.parse('2026-11-14T00:00:00Z'))
		).toBe('no-aplica');
		expect(
			await aplicarOrdenPanel(firmar(orden({ antes: ['central.msp.example'] })), 'panel', AHORA)
		).toBe('no-aplica');
		/* Firmada con el texto tocado. */
		const f = firmar(orden());
		expect(
			await aplicarOrdenPanel(
				{ ...f, orden: f.orden.replace('panel-dr.neutro.example', 'malo.example.net') },
				'panel',
				AHORA
			)
		).toBe('rechazada');
		expect(await panel()).toBe(VIEJO);
	});

	it('no vuelve atrás con una orden más vieja, y un canal cortado no sigue ninguna', async () => {
		await fijar();
		expect(await aplicarOrdenPanel(firmar(orden()), 'panel', AHORA)).toBe('aplicada');
		/* Una de vuelta al viejo, más vieja que la aplicada: no. */
		const vuelta = orden({
			direccion: 'https://otro.neutro.example',
			antes: ['panel-dr.neutro.example'],
			emitida: '2026-11-14T00:00:00.000Z',
			desde: '2026-11-14T00:00:00.000Z'
		});
		expect(await aplicarOrdenPanel(firmar(vuelta), 'panel', AHORA)).toBe('no-aplica');
		expect(await panel()).toBe(NUEVO);
		await limpiar();
		await fijar({ cortado: true });
		expect(await aplicarOrdenPanel(firmar(orden()), 'panel', AHORA)).toBe('no-aplica');
		expect(await panel()).toBe(VIEJO);
	});

	it('puede traer las claves del panel nuevo, si sustituyen a las del suyo', async () => {
		await fijar();
		const o = orden({
			clavesPanel: { claves: [hsmNuevo], reemplaza: [huella(panelViejo.publica)] }
		});
		expect(await aplicarOrdenPanel(firmar(o), 'estatica', AHORA)).toBe('aplicada');
		expect((await estadoCanal())!.huellasPanel).toEqual([huella(hsmNuevo)]);
	});

	it('con el panel callado la busca en el repo público; con el panel vivo, no', async () => {
		/* Aquí manda el reloj de verdad: fechas de verdad. */
		const vigente = firmar(
			orden({
				desde: new Date(Date.now() - 86_400_000).toISOString(),
				caduca: new Date(Date.now() + 10 * 86_400_000).toISOString(),
				emitida: new Date(Date.now() - 86_400_000).toISOString()
			})
		);
		const pedidas: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (u: string) => {
				pedidas.push(String(u));
				if (String(u).includes('transparencia/panel.json'))
					return new Response(JSON.stringify(vigente), { status: 200 });
				throw new Error('sin red');
			})
		);
		await fijar({ ultimoContacto: new Date().toISOString() });
		_olvidarBusquedaOrdenPanel();
		await buscarOrdenPanel();
		expect(pedidas).toEqual([]);
		expect(await panel()).toBe(VIEJO);
		await limpiar();
		await fijar({ ultimoContacto: new Date(Date.now() - 3600_000).toISOString() });
		_olvidarBusquedaOrdenPanel();
		await buscarOrdenPanel();
		expect(pedidas[0]).toContain('transparencia/panel.json');
		expect(await panel()).toBe(NUEVO);
	});
});
