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

const { autorizados, porQueNo, MODULOS_GRATIS } = await import('./catalogo');

describe('autorizados (sin panel / con panel)', () => {
	beforeEach(() => {
		bd.filas = [];
		delete env.EDICION;
	});

	it('community sin panel y sin registro: autoriza solo las gratis', async () => {
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

describe('porQueNo: lo de pago se nombra por su edición, Cloud', () => {
	beforeEach(() => {
		delete env.EDICION;
	});

	it('en community, una de pago viene en Cloud; una gratis fuera de la lista no está incluida', () => {
		env.EDICION = 'community';
		expect(porQueNo({ id: 'mysql', incluida: false, licencia: 'licencia.sin' })).toBe(
			'Included in Sugardaddy Cloud'
		);
		expect(porQueNo({ id: 'cowrie', incluida: false, licencia: 'cubierta' })).toBe(
			'Not included in your subscription'
		);
	});

	it('en community, una de registro lleva a registrarse y dice si ha caducado', () => {
		env.EDICION = 'community';
		expect(porQueNo({ id: 'smb', incluida: false, licencia: 'registro.sin' })).toBe(
			'Free with your registration'
		);
		expect(porQueNo({ id: 'smb', incluida: true, licencia: 'registro.caducado' })).toBe(
			'Your registration has expired'
		);
		expect(porQueNo({ id: 'smb', incluida: true, licencia: 'cubierta' })).toBeNull();
	});

	it('en Cloud: fuera de la suscripción, fuera de la licencia o con la licencia caducada', () => {
		expect(porQueNo({ id: 'mysql', incluida: false, licencia: 'cubierta' })).toBe(
			'Not included in your subscription'
		);
		expect(porQueNo({ id: 'mysql', incluida: true, licencia: 'licencia.sin' })).toBe(
			'Not in your Cloud license'
		);
		expect(porQueNo({ id: 'mysql', incluida: true, licencia: 'licencia.caducada' })).toBe(
			'Your Cloud license has expired'
		);
		expect(porQueNo({ id: 'mysql', incluida: true, licencia: 'cubierta' })).toBeNull();
	});
});
