import { describe, expect, it } from 'vitest';
import { puertosParaAbrir } from './puertos-abrir';

const tcp = (puerto: number) => ({ puerto, protocolo: 'tcp' });

describe('puertosParaAbrir', () => {
	it('agrupa por dirección, con «todas» delante y las direcciones por su valor', () => {
		const r = puertosParaAbrir([
			{ nombre: 'vpn', puertos: [tcp(443)], escucha: '10.50.0.10' },
			{ nombre: 'esxi', puertos: [tcp(443), tcp(22)], escucha: '10.50.0.8' },
			{ nombre: 'dns', puertos: [{ puerto: 53, protocolo: 'udp' }, tcp(53)], escucha: null }
		]);
		expect(r.map((g) => g.direccion)).toEqual([null, '10.50.0.8', '10.50.0.10']);
		expect(r[1].puertos).toEqual([
			{ puerto: 22, protocolo: 'tcp', trampa: 'esxi' },
			{ puerto: 443, protocolo: 'tcp', trampa: 'esxi' }
		]);
		expect(r[0].puertos.map((p) => `${p.puerto}/${p.protocolo}`)).toEqual(['53/tcp', '53/udp']);
	});

	it('dos trampas en la misma dirección comparten fila; sin puertos, no sale', () => {
		const r = puertosParaAbrir([
			{ nombre: 'modbus', puertos: [tcp(502)], escucha: '10.50.0.13' },
			{ nombre: 's7', puertos: [tcp(102)], escucha: '10.50.0.13' },
			{ nombre: 'sin', puertos: [], escucha: '10.50.0.4' }
		]);
		expect(r).toHaveLength(1);
		expect(r[0].puertos.map((p) => p.trampa)).toEqual(['s7', 'modbus']);
	});
});
