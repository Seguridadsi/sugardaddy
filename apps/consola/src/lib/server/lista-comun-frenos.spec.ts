/*
 * Los frenos del nodo a la lista común (docs/diseno/frenos-del-nodo.md): lo que un panel
 * tomado podría meter en el EDL de todos los firewalls y aquí no entra, sin que nadie apruebe
 * nada. La parte con base, en inteligencia.ts (aplicarLista).
 */
import { describe, expect, it } from 'vitest';
import type { IndicadorGlobal } from '@sugardaddy/canal';
import {
	diaDe,
	repartirListaComun,
	topeDia,
	topeValido,
	TOPE_DIA_POR_DEFECTO
} from './lista-comun-frenos';

const ip = (valor: string, clase: IndicadorGlobal['clase'] = 'ip'): IndicadorGlobal => ({
	valor,
	clase,
	motivo: 'Touched a fake service',
	caduca: '2026-11-21T00:00:00.000Z'
});
const base = {
	admitidas: new Set<string>(),
	esperaDesde: new Map<string, Date>(),
	cupo: 100,
	intocables: new Set<string>()
};
const valores = (l: IndicadorGlobal[]) => l.map((i) => i.valor);

describe('lo que nunca entra en el EDL desde la lista común', () => {
	it('una IP de un atacante normal entra', () => {
		const r = repartirListaComun({ ...base, entrantes: [ip('185.220.101.34')] });
		expect(valores(r.entrar)).toEqual(['185.220.101.34']);
		expect(r.rechazadas).toEqual([]);
	});

	it.each([
		['una red', ip('185.220.101.0/24', 'red'), 'not a single IP address'],
		['un hash', ip('abc', 'hash'), 'not a single IP address'],
		['una red disfrazada de ip', ip('0.0.0.0/1'), 'not a single IP address'],
		['el CGNAT de las operadoras', ip('100.64.10.1'), 'carrier-grade NAT'],
		['una privada', ip('10.1.1.1'), 'not a public address'],
		['Cloudflare', ip('104.16.0.1'), 'shared address of Cloudflare'],
		['un DNS público', ip('8.8.8.8'), 'public DNS resolver']
	])('%s no entra', (_, i, motivo) => {
		const r = repartirListaComun({ ...base, entrantes: [i] });
		expect(r.entrar).toEqual([]);
		expect(r.esperar).toEqual([]);
		expect(r.rechazadas[0].motivo).toContain(motivo);
	});

	it('la IP de salida o de un sensor del propio despliegue no entra, escrita como sea', () => {
		const r = repartirListaComun({
			...base,
			intocables: new Set(['203.0.114.7']),
			entrantes: [ip('203.0.114.7'), ip('::ffff:203.0.114.7')]
		});
		expect(r.entrar).toEqual([]);
		expect(r.rechazadas).toEqual([
			{ valor: '203.0.114.7', motivo: expect.stringContaining('this deployment') }
		]);
	});

	it('repetida en la lista cuenta una vez', () => {
		const r = repartirListaComun({
			...base,
			entrantes: [ip('185.220.101.34'), ip('185.220.101.34')]
		});
		expect(r.entrar).toHaveLength(1);
	});
});

describe('el tope de IPs nuevas al día', () => {
	const muchas = Array.from({ length: 5 }, (_, n) => ip(`185.220.101.${n + 1}`));

	it('de lo nuevo entra el cupo y el resto espera', () => {
		const r = repartirListaComun({ ...base, cupo: 2, entrantes: muchas });
		expect(valores(r.entrar)).toEqual(['185.220.101.1', '185.220.101.2']);
		expect(valores(r.esperar)).toEqual(['185.220.101.3', '185.220.101.4', '185.220.101.5']);
	});

	it('lo que ya estaba se queda sin gastar cupo', () => {
		const r = repartirListaComun({
			...base,
			cupo: 1,
			admitidas: new Set(['185.220.101.1', '185.220.101.2']),
			entrantes: muchas
		});
		expect(valores(r.mantener)).toEqual(['185.220.101.1', '185.220.101.2']);
		expect(valores(r.entrar)).toEqual(['185.220.101.3']);
		expect(valores(r.esperar)).toEqual(['185.220.101.4', '185.220.101.5']);
	});

	it('entra antes lo que más lleva esperando, no lo que el panel pone primero', () => {
		const r = repartirListaComun({
			...base,
			cupo: 1,
			esperaDesde: new Map([['185.220.101.5', new Date('2026-11-10')]]),
			entrantes: muchas
		});
		expect(valores(r.entrar)).toEqual(['185.220.101.5']);
	});

	it('con el cupo gastado no entra nada nuevo', () => {
		const r = repartirListaComun({ ...base, cupo: 0, entrantes: muchas });
		expect(r.entrar).toEqual([]);
		expect(r.esperar).toHaveLength(5);
	});

	it('lo que ya estaba y el panel quita, sale', () => {
		const r = repartirListaComun({
			...base,
			admitidas: new Set(['185.220.101.99']),
			entrantes: muchas
		});
		expect(valores(r.mantener)).not.toContain('185.220.101.99');
	});

	it.each([
		[undefined, TOPE_DIA_POR_DEFECTO],
		['', TOPE_DIA_POR_DEFECTO],
		['abc', TOPE_DIA_POR_DEFECTO],
		['25', 25],
		['0', 0],
		['-3', 0],
		['999999', 10_000]
	])('LISTA_COMUN_TOPE_DIA=%s es %s', (v, n) => expect(topeDia(v)).toBe(n));

	it.each([
		['100', 100],
		[0, 0],
		['10000', 10_000],
		['10001', null],
		['-1', null],
		['2.5', null],
		['', null],
		[null, null],
		[undefined, null]
	])('el tope de Lists %s es %s', (v, n) => expect(topeValido(v)).toBe(n));

	it('el día del cupo es el de UTC', () =>
		expect(diaDe(new Date('2026-11-14T23:30:00-02:00'))).toBe('2026-11-15'));
});
