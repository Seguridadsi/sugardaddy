import { describe, expect, it } from 'vitest';
import { enAlcance, enviaDe, valorDe, type Alcance } from './alcance';

const a: Alcance = {
	sensores: { internet: false, sede: true },
	trampas: { vpn: true, raro: false }
};

describe('alcance de una salida por niveles', () => {
	it('sin nada dicho, sale', () => {
		expect(enviaDe({ sensores: {}, trampas: {} }, 't', 's')).toBe(true);
		expect(enAlcance(undefined, { trampas: [{ id: 't', sensor: 's' }] })).toBe(true);
	});

	it('el sensor decide por sus honeypots, y el honeypot gana a su sensor', () => {
		expect(enviaDe(a, 'ssh', 'internet')).toBe(false);
		expect(enviaDe(a, 'vpn', 'internet')).toBe(true);
		expect(enviaDe(a, 'raro', 'sede')).toBe(false);
		expect(enviaDe(a, 'otro', 'sede')).toBe(true);
	});

	it('un incidente sale si alguno de sus honeypots sale', () => {
		const ssh = { id: 'ssh', sensor: 'internet' };
		expect(enAlcance(a, { trampas: [ssh] })).toBe(false);
		expect(enAlcance(a, { trampas: [ssh, { id: 'vpn', sensor: 'internet' }] })).toBe(true);
		expect(enAlcance(a, { trampas: [ssh, { id: 'x', sensor: 'sede' }] })).toBe(true);
	});

	it('un aviso de un sensor sigue al sensor; sin origen, sale', () => {
		expect(enAlcance(a, { sensor: 'internet' })).toBe(false);
		expect(enAlcance(a, { sensor: 'sede' })).toBe(true);
		expect(enAlcance(a, {})).toBe(true);
		expect(enAlcance(a, { trampas: [] })).toBe(true);
	});

	it('valorDe distingue heredado de propio', () => {
		expect(valorDe(a.sensores, 'internet')).toBe('no');
		expect(valorDe(a.sensores, 'sede')).toBe('si');
		expect(valorDe(a.sensores, 'nuevo')).toBe('hereda');
	});
});
