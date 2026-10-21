import { describe, expect, it } from 'vitest';
import {
	contenidaEn,
	esIpPublica,
	firmarLista,
	firmarListaTor,
	generarClaves,
	verificarLista,
	verificarListaTor
} from './index.ts';

describe('qué se puede compartir', () => {
	it.each([
		'10.30.1.77',
		'192.168.1.5',
		'172.20.0.1',
		'127.0.0.1',
		'169.254.1.1',
		'100.64.0.1',
		'192.0.2.10',
		'198.51.100.7',
		'203.0.113.50',
		'224.0.0.1',
		'fd00::1',
		'fe80::1',
		'2001:db8::1',
		'no-es-ip'
	])('%s no sale nunca del nodo', (ip) => expect(esIpPublica(ip)).toBe(false));

	it.each(['185.220.101.34', '8.8.8.8', '45.155.205.11', '2a01:4f8::1'])('%s es pública', (ip) =>
		expect(esIpPublica(ip)).toBe(true)
	);

	it('las redes contienen sus IPs y nada más', () => {
		expect(contenidaEn('20.190.151.7', ['20.0.0.0/8'])).toBe(true);
		expect(contenidaEn('21.0.0.1', ['20.0.0.0/8'])).toBe(false);
		expect(contenidaEn('8.8.8.8', ['8.8.8.8'])).toBe(true);
	});
});

describe('lista global firmada', () => {
	const panel = generarClaves();
	const otro = generarClaves();
	const lista = {
		version: 1 as const,
		emitida: new Date().toISOString(),
		caduca: new Date(Date.now() + 3600_000).toISOString(),
		indicadores: [
			{
				valor: '185.220.101.34',
				clase: 'ip' as const,
				motivo: 'x',
				caduca: new Date().toISOString()
			}
		]
	};

	it('el nodo acepta la lista firmada por el panel', () => {
		expect(verificarLista(panel.publica, firmarLista(panel.privada, lista)).ok).toBe(true);
	});

	it('una lista con una IP añadida por el camino no vale', () => {
		const f = firmarLista(panel.privada, lista);
		const tocada = { ...f, lista: f.lista.replace('185.220.101.34', '10.20.0.10') };
		expect(verificarLista(panel.publica, tocada).ok).toBe(false);
	});

	it('firmada por otra clave no vale', () => {
		expect(verificarLista(panel.publica, firmarLista(otro.privada, lista)).ok).toBe(false);
	});
});

describe('lista de Tor firmada', () => {
	const panel = generarClaves();
	const otro = generarClaves();
	const lista = {
		version: 1 as const,
		tipo: 'tor' as const,
		fuente: 'https://check.torproject.org/torbulkexitlist',
		emitida: new Date().toISOString(),
		caduca: new Date(Date.now() + 86_400_000).toISOString(),
		ips: ['185.220.101.4', '2a0b:f4c2::1']
	};

	it('se acepta con la clave del panel', () => {
		const v = verificarListaTor(panel.publica, firmarListaTor(panel.privada, lista));
		expect(v.ok && v.lista.ips).toEqual(lista.ips);
	});

	it('se rechaza firmada por otra clave', () => {
		expect(verificarListaTor(panel.publica, firmarListaTor(otro.privada, lista)).ok).toBe(false);
	});

	it('se rechaza caducada', () => {
		const vieja = { ...lista, caduca: new Date(Date.now() - 1000).toISOString() };
		expect(verificarListaTor(panel.publica, firmarListaTor(panel.privada, vieja))).toMatchObject({
			ok: false,
			motivo: 'lista caducada'
		});
	});

	it('una lista global firmada no se puede hacer pasar por la de Tor', () => {
		const global = firmarLista(panel.privada, {
			version: 1,
			emitida: lista.emitida,
			caduca: lista.caduca,
			indicadores: []
		});
		expect(verificarListaTor(panel.publica, global).ok).toBe(false);
	});
});
