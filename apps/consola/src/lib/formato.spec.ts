import { describe, expect, it } from 'vitest';
import { dondeVisible, enFrase, estaPuesta, licenciaVisible } from './formato';

describe('el nombre de una forma en una frase', () => {
	it('solo la primera letra pasa a minúscula', () => {
		expect(enFrase('Manual steps for Windows')).toBe('manual steps for Windows');
		expect(enFrase('On a sensor')).toBe('on a sensor');
		expect(enFrase('Script for your AWS console')).toBe('script for your AWS console');
		expect(enFrase('Ésta')).toBe('ésta');
		expect(enFrase('')).toBe('');
	});

	it('un nombre propio o unas siglas se quedan como están', () => {
		expect(enFrase('Windows steps')).toBe('Windows steps');
		expect(enFrase('Linux and macOS steps')).toBe('Linux and macOS steps');
		expect(enFrase('Linux/macOS steps')).toBe('Linux/macOS steps');
		expect(enFrase('Microsoft Entra ID steps')).toBe('Microsoft Entra ID steps');
		expect(enFrase('macOS steps')).toBe('macOS steps');
		for (const nombre of ['Docker', 'Azure', 'Sophos', 'Redis', 'Cowrie', 'Kerberos'])
			expect(enFrase(`${nombre} steps`)).toBe(`${nombre} steps`);
		for (const siglas of ['SSH', 'RDP', 'KeePass', 'FortiGate', 'AWS'])
			expect(enFrase(`${siglas} steps`)).toBe(`${siglas} steps`);
	});
});

describe('dónde escucha una trampa', () => {
	it('lo guardado se enseña en inglés; una dirección, tal cual', () => {
		expect(dondeVisible('IP propia 10.20.0.240')).toBe('Own IP 10.20.0.240');
		expect(dondeVisible('desplegando…')).toBe('deploying…');
		expect(dondeVisible('aplicando cambios…')).toBe('applying changes…');
		expect(dondeVisible('0.0.0.0:22, 0.0.0.0:23')).toBe('0.0.0.0:22, 0.0.0.0:23');
	});

	it('solo se enseña puesta: mientras su sensor la pone, «donde» es lo que cuenta él', () => {
		expect(estaPuesta('comprobada')).toBe(true);
		expect(estaPuesta('colocada')).toBe(true);
		for (const e of ['por-colocar', 'degradada', 'parada', 'sin-contacto', 'retirando'])
			expect(estaPuesta(e)).toBe(false);
	});
});

describe('licenciaVisible', () => {
	it('pasa al inglés lo nuestro y deja las licencias como están', () => {
		expect(
			licenciaVisible('Código propio (SeguridadSI); biblioteca estándar de Go, BSD-3-Clause')
		).toBe('In-house code (SeguridadSI); Go standard library, BSD-3-Clause');
		expect(licenciaVisible('MIT AND BSD-3-Clause')).toBe('MIT AND BSD-3-Clause');
	});
});
