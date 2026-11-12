import { describe, expect, it } from 'vitest';
import { ipPublicaSensor } from './ip-publica-sensor';

describe('ipPublicaSensor', () => {
	it('la dirección pública de su propia máquina', () => {
		expect(ipPublicaSensor(['10.0.0.4', '20.50.60.70'], '10.0.0.4')).toBe('20.50.60.70');
	});
	it('IPv4 antes que IPv6', () => {
		expect(ipPublicaSensor(['2a01:111::5', '20.50.60.70'], null)).toBe('20.50.60.70');
		expect(ipPublicaSensor(['2a01:111::5', '10.0.0.4'], null)).toBe('2a01:111::5');
	});
	it('si no, la IP desde la que llega a la consola', () => {
		expect(ipPublicaSensor(['10.0.0.4'], '52.1.2.3')).toBe('52.1.2.3');
		expect(ipPublicaSensor([], '::ffff:52.1.2.3')).toBe('52.1.2.3');
	});
	it('la que ha preguntado el propio sensor, antes que nada', () => {
		expect(ipPublicaSensor(['192.168.1.20'], '192.168.1.20', '80.1.2.3')).toBe('80.1.2.3');
		expect(ipPublicaSensor(['10.0.0.4'], '52.1.2.3', '80.1.2.3')).toBe('80.1.2.3');
		expect(ipPublicaSensor(['10.0.0.4'], '52.1.2.3', '10.9.9.9')).toBe('52.1.2.3');
		expect(ipPublicaSensor(['10.0.0.4'], null, 7)).toBeNull();
	});
	it('por la red interna no se sabe', () => {
		expect(ipPublicaSensor(['192.168.1.20', '172.17.0.1'], '192.168.1.20')).toBeNull();
		expect(ipPublicaSensor(['100.64.0.9', '169.254.1.1', '168.63.129.16'], null)).toBeNull();
		expect(ipPublicaSensor([], 'no-es-una-ip')).toBeNull();
	});
});
