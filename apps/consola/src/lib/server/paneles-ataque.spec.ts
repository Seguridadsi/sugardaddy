import { afterEach, describe, expect, it, vi } from 'vitest';
import { _esperar, _probar, panelesDe } from './paneles-ataque';

afterEach(() => _probar(null));

describe('paneles de agentes de IA de ataque', () => {
	it('pregunta solo por IP públicas, sin esperar, y contesta en la carga siguiente', async () => {
		const preguntar = vi.fn(async (ips: string[]) => {
			expect(ips).toEqual(['92.255.57.17', '8.8.8.8']);
			return { '92.255.57.17': { agente: 'ARTEX', version: 'dev', visto: '2026-11-03T05:17:41Z' } };
		});
		_probar(preguntar);
		expect(panelesDe(['92.255.57.17', '10.0.0.5', '8.8.8.8', '192.168.1.1']).size).toBe(0);
		await _esperar();
		const r = panelesDe(['92.255.57.17', '8.8.8.8']);
		expect(r.get('92.255.57.17')?.agente).toBe('ARTEX');
		expect(r.has('8.8.8.8')).toBe(false);
		/* Lo sabido (también el «no está») no se vuelve a preguntar. */
		await _esperar();
		expect(preguntar).toHaveBeenCalledTimes(1);
	});

	it('sin vía a la central no hay pista y se espera antes de volver a preguntar', async () => {
		const preguntar = vi.fn(async () => null);
		_probar(preguntar);
		panelesDe(['92.255.57.17']);
		await _esperar();
		panelesDe(['92.255.57.17']);
		await _esperar();
		expect(preguntar).toHaveBeenCalledTimes(1);
	});

	it('descarta lo que no tiene forma de respuesta', async () => {
		_probar(async () => ({ '92.255.57.17': { agente: '<script>' } }) as never);
		panelesDe(['92.255.57.17']);
		await _esperar();
		expect(panelesDe(['92.255.57.17']).size).toBe(0);
	});
});
