import { describe, expect, it } from 'vitest';
import {
	contenidaEn,
	esIpPublica,
	firmarLista,
	firmarListaTor,
	generarClaves,
	MAXIMO_PAISES_SENSOR,
	sensoresValidos,
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
		/* Reservadas con el primer HEXTETO fuera de 2000::/3, pero cuyo texto
		 * empieza por «2»/«3»: el bug las daba por públicas (miraba el carácter). */
		'2::',
		'20::',
		'200::',
		'2a::',
		'2:a::b',
		'1fff::1',
		'4000::1',
		'no-es-ip'
	])('%s no sale nunca del nodo', (ip) => expect(esIpPublica(ip)).toBe(false));

	it.each([
		'185.220.101.34',
		'8.8.8.8',
		'45.155.205.11',
		'2a01:4f8::1',
		'2000::',
		'3fff::1',
		'2606:4700::1'
	])('%s es pública', (ip) => expect(esIpPublica(ip)).toBe(true));

	it('2:: y 0002:: son la misma dirección reservada: ninguna sale', () => {
		expect(esIpPublica('2::')).toBe(false);
		expect(esIpPublica('0002::')).toBe(false);
	});

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

	/* Auditoría 2026-11-14, «canal firmado»: `tipo` dentro de lo firmado. */
	it('con tipo «global» se acepta y no es legado', () => {
		const v = verificarLista(
			panel.publica,
			firmarLista(panel.privada, { ...lista, tipo: 'global' })
		);
		expect(v).toMatchObject({ ok: true, legado: false });
	});

	it('con el tipo cambiado no vale: ni otro tipo ni uno inventado', () => {
		for (const tipo of ['tor', 'estado', 'globa1'])
			expect(
				verificarLista(
					panel.publica,
					firmarLista(panel.privada, { ...lista, tipo } as unknown as typeof lista)
				),
				tipo
			).toEqual({ ok: false, motivo: 'not a global list' });
	});

	it('cambiar el tipo por el camino rompe la firma', () => {
		const f = firmarLista(panel.privada, { ...lista, tipo: 'global' });
		const tocada = { ...f, lista: f.lista.replace('"tipo":"global"', '"tipo":"tor"') };
		expect(verificarLista(panel.publica, tocada)).toEqual({
			ok: false,
			motivo: 'list not signed by Central'
		});
	});

	it('una lista de Tor firmada por el panel no pasa por lista global', () => {
		const tor = firmarListaTor(panel.privada, {
			version: 1,
			tipo: 'tor',
			fuente: 'x',
			emitida: lista.emitida,
			caduca: lista.caduca,
			ips: ['185.220.101.4']
		});
		expect(verificarLista(panel.publica, tor)).toEqual({ ok: false, motivo: 'not a global list' });
	});

	it('un estado deseado firmado por el panel no pasa por lista global, con tipo o sin él', () => {
		const estado = {
			version: 1,
			cliente: 'aldanza',
			modulos: [],
			emitido: lista.emitida,
			caduca: lista.caduca
		};
		for (const e of [estado, { ...estado, tipo: 'estado' }])
			expect(
				verificarLista(panel.publica, firmarLista(panel.privada, e as unknown as typeof lista))
			).toEqual({ ok: false, motivo: 'not a global list' });
	});

	it('compatibilidad: la lista sin tipo de un panel anterior se acepta, marcada como legado', () => {
		expect(verificarLista(panel.publica, firmarLista(panel.privada, lista))).toMatchObject({
			ok: true,
			legado: true
		});
	});

	it('una caducidad que no se lee no vale para siempre', () => {
		const rara = firmarLista(panel.privada, { ...lista, caduca: 'nunca' });
		expect(verificarLista(panel.publica, rara)).toEqual({ ok: false, motivo: 'list expired' });
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
			motivo: 'list expired'
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

describe('los módulos de un indicador', () => {
	it('solo identificadores de módulo, sin repetir, ordenados y con tope', async () => {
		const { modulosValidos, MAXIMO_MODULOS } = await import('./indicadores.ts');
		expect(modulosValidos(['rdp', 'cowrie', 'rdp'])).toEqual(['cowrie', 'rdp']);
		expect(modulosValidos(['Cowrie', 'srv backup acme', '../x', 7, null, ''])).toEqual([]);
		expect(modulosValidos('cowrie')).toEqual([]);
		const muchos = Array.from({ length: 30 }, (_, i) => `m${i}`);
		expect(modulosValidos(muchos)).toHaveLength(MAXIMO_MODULOS);
	});
});

describe('los agentes de IA de un indicador', () => {
	it('solo los del vocabulario, sin repetir y ordenados', async () => {
		const { agentesValidos } = await import('./indicadores.ts');
		expect(agentesValidos(['ARTEX?', 'ARTEX', 'ARTEX'])).toEqual(['ARTEX', 'ARTEX?']);
		expect(agentesValidos(['GPTBot', 'my-agent "x"', 7, null, ''])).toEqual([]);
		expect(agentesValidos('ARTEX')).toEqual([]);
	});
});

describe('sensoresValidos', () => {
	it('suma por país, descarta lo malformado y no pasa del total del indicador', () => {
		expect(
			sensoresValidos(
				[
					{ pais: 'FR', eventos: 4, modulos: ['redis'] },
					{ pais: 'US', eventos: 3, modulos: ['rdp', 'MAL'] },
					{ pais: 'FR', eventos: 2, modulos: ['vnc'] },
					{ pais: 'fr', eventos: 1 },
					{ pais: 'ES', eventos: 0 },
					{ pais: 'DE', eventos: 1.5 },
					'US',
					null
				],
				8
			)
		).toEqual([
			{ pais: 'FR', eventos: 6, modulos: ['redis', 'vnc'] },
			{ pais: 'US', eventos: 2, modulos: ['rdp'] }
		]);
	});
	it('sin lista, nada', () => {
		expect(sensoresValidos(undefined, 5)).toEqual([]);
		expect(sensoresValidos({ pais: 'FR', eventos: 1 }, 5)).toEqual([]);
	});
	it('como mucho 20 países', () => {
		const muchos = Array.from({ length: 30 }, (_, i) => ({
			pais: String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
			eventos: 1
		}));
		expect(sensoresValidos(muchos, 100)).toHaveLength(MAXIMO_PAISES_SENSOR);
	});
});
