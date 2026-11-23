/*
 * @sugardaddy/canal también lo carga código del navegador (el panel: atencion-flota.ts), y
 * allí no hay Buffer. Un Buffer.from al nivel del módulo se cuela en el bundle del cliente
 * y rompe la página entera («Buffer is not defined»): pasó con sello-rele.ts en la imagen
 * 0.33.0-suricata del panel. Cargar el índice sin Buffer no puede fallar.
 */
import { describe, expect, it } from 'vitest';

describe('el índice se carga sin Buffer, como en el navegador', () => {
	it('ningún módulo usa Buffer al cargarse', async () => {
		const g = globalThis as { Buffer?: unknown };
		const guardado = g.Buffer;
		delete g.Buffer;
		try {
			await expect(import('./index.ts?sin-buffer')).resolves.toBeDefined();
		} finally {
			g.Buffer = guardado;
		}
	});
});
