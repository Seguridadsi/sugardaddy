/*
 * La comprobación de versión de un nodo sin panel: qué queda apuntado para Ajustes según lo
 * que se pudo leer. La red, la base y la versión firmada se sustituyen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const nodo = vi.hoisted(() => ({
	panel: false,
	avisar: true,
	firmada: { visto: 'no-aplica' } as
		| { visto: 'no-aplica' | 'sin-red' }
		| { visto: 'rechazada'; motivo: string }
		| { visto: 'al-dia' | 'pendiente'; version: string },
	disponible: undefined as string | null | undefined,
	apuntado: undefined as unknown,
	avisos: 0
}));
vi.mock('./canal', () => ({
	gestionadoPorPanel: async () => nodo.panel,
	considerarCommunity: async () => (nodo.panel ? { visto: 'no-aplica' } : nodo.firmada)
}));
vi.mock('./consultas', () => ({
	buscarActualizaciones: async () => nodo.avisar,
	cabecera: async () => ({ cliente: { version: '0.28.1' } }),
	guardarActualizacionDisponible: async (v: string | null) => {
		nodo.disponible = v;
	},
	guardarComprobacionVersion: async (v: unknown) => {
		nodo.apuntado = v;
	}
}));

vi.mock('./registro', () => ({
	avisarContacto: async () => {
		nodo.avisos += 1;
		return 'avisado';
	}
}));

const { comprobarVersiones } = await import('./actualizaciones');
const AHORA = new Date('2026-11-12T12:00:00Z');
const responde = (texto: string | null) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			if (texto === null) throw new Error('sin red');
			return new Response(texto);
		})
	);

describe('comprobar si hay versión nueva', () => {
	beforeEach(() => {
		Object.assign(nodo, {
			panel: false,
			avisar: true,
			firmada: { visto: 'no-aplica' },
			disponible: undefined,
			apuntado: undefined,
			avisos: 0
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('solo con el aviso: apunta la versión publicada y la deja disponible si es mayor', async () => {
		responde('0.29.0\n');
		expect(await comprobarVersiones(AHORA)).toEqual({
			cuando: '2026-11-12T12:00:00.000Z',
			red: true,
			version: '0.29.0',
			rechazada: null
		});
		expect(nodo.disponible).toBe('0.29.0');
		expect(nodo.apuntado).toMatchObject({ version: '0.29.0' });
	});

	it('al día: lo apunta y no deja nada disponible', async () => {
		responde('0.28.1');
		expect(await comprobarVersiones(AHORA)).toMatchObject({ red: true, version: '0.28.1' });
		expect(nodo.disponible).toBeNull();
	});

	it('sin red: queda apuntado que no se pudo leer, y lo disponible no se toca', async () => {
		responde(null);
		nodo.firmada = { visto: 'sin-red' };
		expect(await comprobarVersiones(AHORA)).toMatchObject({ red: false, version: null });
		expect(nodo.disponible).toBeUndefined();
	});

	it('con actualización automática, manda la versión firmada', async () => {
		responde('0.30.0');
		nodo.firmada = { visto: 'pendiente', version: '0.29.0' };
		expect(await comprobarVersiones(AHORA)).toMatchObject({ red: true, version: '0.29.0' });
	});

	it('una versión firmada que no se acepta queda dicha, con su motivo', async () => {
		responde('0.29.0');
		nodo.firmada = { visto: 'rechazada', motivo: 'the signature does not match' };
		expect(await comprobarVersiones(AHORA)).toMatchObject({
			red: true,
			rechazada: 'the signature does not match'
		});
	});

	it('con el aviso apagado y sin actualización automática no apunta nada', async () => {
		nodo.avisar = false;
		expect(await comprobarVersiones(AHORA)).toBeNull();
		expect(nodo.apuntado).toBeUndefined();
		expect(nodo.disponible).toBeNull();
	});

	it('cada comprobación le da al registro la ocasión de contar su versión, una vez', async () => {
		responde('0.28.1');
		await comprobarVersiones(AHORA);
		expect(nodo.avisos).toBe(1);
	});

	it('un nodo con panel no mira ni apunta nada', async () => {
		nodo.panel = true;
		responde('0.29.0');
		expect(await comprobarVersiones(AHORA)).toBeNull();
		expect(nodo.apuntado).toBeUndefined();
	});
});
