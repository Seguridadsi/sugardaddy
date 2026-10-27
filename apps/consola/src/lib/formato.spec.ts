import { describe, expect, it } from 'vitest';
import { enFrase, estaPuesta } from './formato';

describe('el nombre de una forma en una frase', () => {
	it('solo la primera letra pasa a minúscula', () => {
		expect(enFrase('Pasos para Windows')).toBe('pasos para Windows');
		expect(enFrase('En un sensor')).toBe('en un sensor');
		expect(enFrase('Ésta')).toBe('ésta');
		expect(enFrase('')).toBe('');
	});
});

describe('dónde escucha una trampa', () => {
	it('solo se enseña puesta: mientras su sensor la pone, «donde» es lo que cuenta él', () => {
		expect(estaPuesta('comprobada')).toBe(true);
		expect(estaPuesta('colocada')).toBe(true);
		for (const e of ['por-colocar', 'degradada', 'parada', 'sin-contacto', 'retirando'])
			expect(estaPuesta(e)).toBe(false);
	});
});
