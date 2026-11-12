import { describe, expect, it } from 'vitest';
import { ipBuscada } from './buscar-ip';

describe('ipBuscada', () => {
	it('una dirección entera, en cualquiera de sus escrituras', () => {
		expect(ipBuscada(' 88.21.10.197 ')).toEqual({ clase: 'ip', ip: '88.21.10.197' });
		expect(ipBuscada('::ffff:88.21.10.197')).toEqual({ clase: 'ip', ip: '88.21.10.197' });
		expect(ipBuscada('2A01:0111:0000::5')).toEqual({ clase: 'ip', ip: '2a01:111::5' });
		expect(ipBuscada('[2a01:111::5]')).toEqual({ clase: 'ip', ip: '2a01:111::5' });
	});
	it('un prefijo CIDR, con los octetos que comparte', () => {
		expect(ipBuscada('88.21.0.0/16')).toEqual({
			clase: 'cidr',
			cidr: '88.21.0.0/16',
			comun: '88.21.'
		});
		expect(ipBuscada('88.21.10.128/25')).toEqual({
			clase: 'cidr',
			cidr: '88.21.10.128/25',
			comun: '88.21.10.'
		});
		expect(ipBuscada('10.0.0.0/7')).toEqual({ clase: 'cidr', cidr: '10.0.0.0/7', comun: null });
		expect(ipBuscada('88.21.10.197/32')).toMatchObject({ comun: '88.21.10.197' });
		expect(ipBuscada('2A01:111::/32')).toEqual({
			clase: 'cidr',
			cidr: '2a01:111::/32',
			comun: null
		});
	});
	it('lo demás es texto', () => {
		for (const t of [
			'',
			'88.21.',
			'88.21.10.197 wget',
			'wget',
			'88.21.10.197/33',
			'1.2.3.4/x',
			'/24',
			'::/129'
		])
			expect(ipBuscada(t)).toBeNull();
		expect(ipBuscada(null)).toBeNull();
	});
});
