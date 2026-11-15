/* La prueba de salida del nodo (salida.ts): qué destinos, cómo cuenta y qué dice al fallar. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
const { destinos, motivo, probar, proxyPresente } = await import('./salida');

describe('salida a internet del nodo', () => {
	it('proxy.presente sale del entorno, sin enseñar la dirección', () => {
		expect(proxyPresente({})).toBe(false);
		expect(proxyPresente({ HTTPS_PROXY: 'http://u:p@proxy:3128' })).toBe(true);
	});

	it('prueba el panel, el registro y Entra si los usa; nada del cliente', () => {
		expect(
			destinos('https://sugardaddy-central.azurewebsites.net', {
				REGISTRO: 'ghcr.io',
				ENTRA_TENANT_ID: 'x'
			})
		).toEqual([
			{
				destino: 'sugardaddy-central.azurewebsites.net',
				url: 'https://sugardaddy-central.azurewebsites.net/'
			},
			{ destino: 'ghcr.io', url: 'https://ghcr.io/v2/' },
			{
				destino: 'login.microsoftonline.com',
				url: 'https://login.microsoftonline.com/common/discovery/keys'
			}
		]);
		expect(destinos(null, { REGISTRO: 'mal/escrito' })).toEqual([]);
	});

	it('cualquier respuesta cuenta como alcanzado; no llegar, con su motivo', async () => {
		const pedir = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes('bien')) return new Response('', { status: 401 });
			throw Object.assign(new TypeError('fetch failed'), {
				cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND mal' }
			});
		}) as unknown as typeof fetch;
		expect(
			await probar(
				[
					{ destino: 'bien', url: 'https://bien/v2/' },
					{ destino: 'mal', url: 'https://mal/' }
				],
				pedir
			)
		).toEqual([
			{ destino: 'bien', ok: true, detalle: null },
			{ destino: 'mal', ok: false, detalle: 'the name does not resolve' }
		]);
	});

	it('los motivos dicen qué hacer y nunca enseñan la contraseña del proxy', () => {
		/* Tal como lo da fetch de Node 22 con NODE_USE_ENV_PROXY y una contraseña mala. */
		const mala = Object.assign(new TypeError('fetch failed'), {
			cause: Object.assign(new Error('Request was cancelled.'), {
				code: 0,
				cause: Object.assign(new Error('Proxy response (407) !== 200 when HTTP Tunneling'), {
					code: 'UND_ERR_ABORTED'
				})
			})
		});
		expect(motivo(mala)).toBe('the proxy asks for authentication (407)');
		expect(motivo({ cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', message: 'x' } })).toMatch(
			/install its CA/
		);
		expect(
			motivo({ cause: { code: 'EX', message: 'via http://u:secreto@proxy:3128 failed' } })
		).not.toContain('secreto');
	});
});
