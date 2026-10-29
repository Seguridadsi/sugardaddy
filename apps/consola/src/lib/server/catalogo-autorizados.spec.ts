/*
 * Qué módulos autoriza la consola (catalogo.ts → autorizados), sin tocar el
 * sistema de ficheros del catálogo: la lista la manda el panel por el ajuste
 * «modulos»; sin panel, la edición community (que no tiene panel) autoriza las
 * trampas gratis —lo único desplegable sin licencia— y la de pago, nada hasta
 * el primer latido firmado. Base y entorno se mockean para poder importar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env }));

/* La fila del ajuste «modulos» que devuelve la base, configurable por prueba. */
const bd = vi.hoisted(() => ({ filas: [] as { valor: unknown }[] }));
vi.mock('./db', () => ({
	db: { select: () => ({ from: () => ({ where: async () => bd.filas }) }) },
	schema: { ajustes: { clave: 'clave' } }
}));

const { autorizados, MODULOS_GRATIS } = await import('./catalogo');

describe('autorizados (sin panel / con panel)', () => {
	beforeEach(() => {
		bd.filas = [];
		delete env.EDICION;
	});

	it('community sin panel: autoriza todas las trampas gratis', async () => {
		env.EDICION = 'community';
		expect(new Set(await autorizados())).toEqual(new Set(MODULOS_GRATIS));
	});

	it('edición de pago sin panel: nada hasta el primer latido', async () => {
		expect(await autorizados()).toEqual([]);
	});

	it('con lista del panel: manda el panel (también en community)', async () => {
		bd.filas = [{ valor: ['cowrie'] }];
		env.EDICION = 'community';
		expect(await autorizados()).toEqual(['cowrie']);
	});
});
