import { describe, expect, it } from 'vitest';
import { armarAtencion } from './atencion';

const sensor = (extra: object = {}) => ({
	id: 's1',
	nombre: 'DMZ',
	vivo: true,
	ultimoLatido: '2026-11-11T10:00:00Z',
	avisos: [],
	...extra
});

describe('lo que necesita atención', () => {
	it('con todo en orden, nada', () => {
		expect(
			armarAtencion({
				sensores: [sensor()],
				trampas: [{ estado: 'comprobada' }, { estado: 'parada' }, { estado: 'retirando' }],
				salidas: [{ id: 'a', nombre: 'SIEM', fallosSeguidos: 0, ultimoError: 'de antes' }]
			})
		).toEqual([]);
	});

	it('un sensor caído, uno que nunca conectó y uno con un aviso grave', () => {
		const r = armarAtencion({
			sensores: [
				sensor({ vivo: false }),
				sensor({ id: 's2', nombre: 'Planta', vivo: false, ultimoLatido: null }),
				sensor({
					id: 's3',
					nombre: 'Sede',
					avisos: [
						{ gravedad: 'error', titulo: 'No container engine' },
						{ gravedad: 'aviso', titulo: 'Old version' }
					]
				})
			],
			trampas: [],
			salidas: []
		});
		expect(r.map((x) => x.texto)).toEqual([
			'Sensor "DMZ" is offline: its honeypots are not reporting.',
			'Sensor "Planta" has never connected.',
			'Sensor "Sede": No container engine'
		]);
		expect(r.every((x) => x.gravedad === 'error' && x.href === '/sensors')).toBe(true);
	});

	it('una salida que no entrega lleva a su ficha, con su error', () => {
		expect(
			armarAtencion({
				sensores: [],
				trampas: [],
				salidas: [{ id: 'abc', nombre: 'Email', fallosSeguidos: 3, ultimoError: 'timeout' }]
			})
		).toEqual([
			{ gravedad: 'error', texto: 'Output "Email" is not delivering: timeout', href: '/alerts/abc' }
		]);
	});

	it('los honeypots se cuentan por estado, y lo roto va antes que lo pendiente', () => {
		const r = armarAtencion({
			sensores: [],
			trampas: [
				{ estado: 'colocada' },
				{ estado: 'colocada' },
				{ estado: 'por-colocar' },
				{ estado: 'degradada' },
				{ estado: 'sin-contacto' }
			],
			salidas: []
		});
		expect(r.map((x) => [x.gravedad, x.texto])).toEqual([
			['error', '1 honeypot is degraded.'],
			['aviso', '2 honeypots are active but not verified with a real event yet.'],
			['aviso', '1 honeypot is pending deployment.']
		]);
	});
});
