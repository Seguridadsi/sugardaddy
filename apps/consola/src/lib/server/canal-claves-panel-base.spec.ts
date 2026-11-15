/*
 * Las claves del panel en las que confía el nodo (docs/diseno/panel-endurecido.md): solo las
 * cambia una versión firmada con la clave de publicación, solo si es para este panel y nunca
 * una versión más vieja que la que dio la lista. DATABASE_URL (del entorno o de .env); si no
 * hay, se salta.
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { firmarRelease, generarClaves, huella, type Release } from '@sugardaddy/canal';

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

const ed = generarClaves();
const hsm = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	.publicKey.export({ format: 'der', type: 'spki' })
	.toString('base64');
const msp = generarClaves();
const nodo = generarClaves();
const D = '@sha256:' + 'a'.repeat(64);
const release = (version: string, clavesPanel: Release['clavesPanel']): Release => ({
	version,
	publicada: '2026-11-14T10:00:00Z',
	notas: 'x',
	servicios: { consola: `ejemplo.azurecr.io/sugardaddy-consola${D}` },
	clavesPanel
});

describe.skipIf(!hayBase)('las claves del panel en el nodo', async () => {
	const { db, schema: s } = await import('./db');
	const { eq } = await import('drizzle-orm');
	const { adoptarClavesPanel, estadoCanal, _adoptarDeLoGuardado } = await import('./canal');

	const fijar = (clavePublicaPanel: string) =>
		db.insert(s.ajustes).values({
			clave: 'canal',
			valor: {
				panel: 'http://localhost:9',
				nodo: 'zz-cp-nodo',
				cliente: 'zz-cp',
				clavePrivada: nodo.privada,
				clavePublica: nodo.publica,
				clavePublicaPanel,
				cortado: false,
				ultimoContacto: null,
				error: null,
				estado: null
			}
		});
	const huellas = async () => (await estadoCanal())!.huellasPanel;

	beforeEach(async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
	});
	afterAll(async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
	});

	it('la transición y la retirada, y nunca hacia atrás', async () => {
		await fijar(ed.publica);
		expect(await huellas()).toEqual([huella(ed.publica)]);
		await adoptarClavesPanel(release('0.30.0', { claves: [ed.publica, hsm] }));
		expect(await huellas()).toEqual([huella(ed.publica), huella(hsm)]);
		await adoptarClavesPanel(release('0.31.0', { claves: [hsm], reemplaza: [huella(ed.publica)] }));
		expect(await huellas()).toEqual([huella(hsm)]);
		/* Una versión más vieja, auténtica pero de antes, no devuelve la clave retirada. */
		await adoptarClavesPanel(release('0.30.0', { claves: [ed.publica, hsm] }));
		expect(await huellas()).toEqual([huella(hsm)]);
		/* La principal que se enseña sigue siendo la del alta. */
		expect((await estadoCanal())!.huellaPanel).toBe(huella(ed.publica));
	});

	it('las toma de la versión guardada aunque el panel ya no la mande', async () => {
		const pub = generarClaves();
		process.env.PUBLICACION_CLAVE_PUBLICA = pub.publica;
		await fijar(ed.publica);
		const firmada = firmarRelease(pub.privada, release('0.30.0', { claves: [ed.publica, hsm] }));
		await db
			.insert(s.ajustes)
			.values({ clave: 'release', valor: { version: '0.30.0', firmada } })
			.onConflictDoUpdate({
				target: s.ajustes.clave,
				set: { valor: { version: '0.30.0', firmada } }
			});
		await _adoptarDeLoGuardado();
		expect(await huellas()).toEqual([huella(ed.publica), huella(hsm)]);
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'release'));
		delete process.env.PUBLICACION_CLAVE_PUBLICA;
	});

	it('un nodo de otro panel (un MSP) no cambia sus claves', async () => {
		await fijar(msp.publica);
		await adoptarClavesPanel(release('0.30.0', { claves: [hsm], reemplaza: [huella(ed.publica)] }));
		expect(await huellas()).toEqual([huella(msp.publica)]);
	});
});
