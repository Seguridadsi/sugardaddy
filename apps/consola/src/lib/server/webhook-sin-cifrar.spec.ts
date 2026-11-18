/*
 * Endurecimiento de la auditoría del 2026-11-14 (h04): el webhook community
 * por http:// solo sale a direcciones privadas, como Avisos y SIEM. Sin base:
 * la configuración y los eventos se fingen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const estado = vi.hoisted(() => ({
	url: '',
	fallos: [] as (string | null)[]
}));

vi.mock('./consultas', () => ({
	webhook: async () => ({ activo: true, url: estado.url, secreto: null, secretoCifrado: null }),
	secretoWebhook: () => null,
	webhookPos: async () => ({ recibido: new Date(0).toISOString(), id: '' }),
	eventosParaWebhook: async () => [
		{ id: 'e1', linea: '{"usuario":"root","clave":"hunter2"}', recibido: new Date() }
	],
	guardarWebhookPos: async () => {},
	guardarFalloWebhook: async (f: { detalle: string } | null) => {
		estado.fallos.push(f?.detalle ?? null);
	}
}));

const { enviarWebhookPendientes } = await import('./webhook');

describe('webhook community sin cifrar', () => {
	beforeEach(() => {
		estado.fallos = [];
	});

	it('por http:// a una IP pública no sale, y queda dicho', async () => {
		estado.url = 'http://8.8.8.8/eventos';
		await enviarWebhookPendientes();
		expect(estado.fallos.at(-1)).toMatch(
			/^not sent: .*unencrypted traffic is only sent to private/
		);
	});

	it('por http:// a una IP privada sí lo intenta (aquí no contesta nadie)', async () => {
		estado.url = 'http://10.255.255.1:9/eventos';
		await enviarWebhookPendientes();
		expect(estado.fallos.at(-1) ?? '').not.toMatch(/private addresses/);
	}, 20_000);
});
