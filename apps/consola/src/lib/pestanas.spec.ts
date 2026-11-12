import { describe, expect, it } from 'vitest';
import { enlacePestana, pestanaDe } from './pestanas';

const P = [
	{ id: 'incidents', texto: 'Incidents' },
	{ id: 'settings', texto: 'Alert settings' }
] as const;

describe('pestañas de una página', () => {
	it('la primera es la de serie; una que no existe no vale', () => {
		expect(pestanaDe(new URL('https://c/incidents'), P)).toBe('incidents');
		expect(pestanaDe(new URL('https://c/incidents?tab=settings'), P)).toBe('settings');
		expect(pestanaDe(new URL('https://c/incidents?tab=otra'), P)).toBe('incidents');
	});

	it('el enlace conserva el resto de la dirección y la primera no lleva parámetro', () => {
		const u = new URL('https://c/incidents?por=usuario&tab=settings');
		expect(enlacePestana(u, P, 'incidents')).toBe('/incidents?por=usuario');
		expect(enlacePestana(u, P, 'settings')).toBe('/incidents?por=usuario&tab=settings');
		expect(enlacePestana(new URL('https://c/incidents'), P, 'incidents')).toBe('/incidents');
	});
});
