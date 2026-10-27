import { describe, expect, it } from 'vitest';
import { leerRed, leerVlan, redDelFormulario, redYVlan } from './red';

describe('red y VLAN de un sensor', () => {
	it('la red se queda con la dirección de la red', () => {
		expect(leerRed('10.70.0.5/24')).toBe('10.70.0.0/24');
		expect(leerRed(' 172.16.10.33/27 ')).toBe('172.16.10.32/27');
		expect(leerRed('192.168.1.7/32')).toBe('192.168.1.7/32');
		expect(leerRed('10.0.0.0/8')).toBe('10.0.0.0/8');
	});

	it('vacía es null; lo que no es un CIDR IPv4 de /8 a /32, undefined', () => {
		expect(leerRed('')).toBeNull();
		for (const x of [
			'10.70.0.0',
			'10.70.0.0/7',
			'10.70.0.0/33',
			'999.1.1.1/24',
			'10.1/16',
			'fd00::/64',
			'VLAN 70',
			'01.2.3.4/24'
		])
			expect(leerRed(x), x).toBeUndefined();
	});

	it('la VLAN va del 1 al 4094', () => {
		expect(leerVlan('70')).toBe(70);
		expect(leerVlan('')).toBeNull();
		for (const x of ['0', '4095', '7a', '-1', '12345']) expect(leerVlan(x), x).toBeUndefined();
	});

	it('se enseñan juntas, o lo que haya', () => {
		expect(redYVlan('10.70.0.0/24', 70)).toBe('10.70.0.0/24 · VLAN 70');
		expect(redYVlan('10.70.0.0/24', null)).toBe('10.70.0.0/24');
		expect(redYVlan(null, 70)).toBe('VLAN 70');
		expect(redYVlan(null, null)).toBe('');
	});

	it('del formulario, o el error que enseñar', () => {
		const f = (red: string, vlan: string) => {
			const x = new FormData();
			x.set('red', red);
			x.set('vlan', vlan);
			return x;
		};
		expect(redDelFormulario(f('10.70.0.9/24', '70'))).toEqual({ red: '10.70.0.0/24', vlan: 70 });
		expect(redDelFormulario(f('', ''))).toEqual({ red: null, vlan: null });
		expect(redDelFormulario(f('x', ''))).toHaveProperty('error');
		expect(redDelFormulario(f('', '5000'))).toHaveProperty('error');
	});
});
