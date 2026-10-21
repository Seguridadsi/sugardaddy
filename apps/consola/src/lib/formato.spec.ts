import { describe, expect, it } from 'vitest';
import { enFrase } from './formato';

describe('el nombre de una forma en una frase', () => {
	it('solo la primera letra pasa a minúscula', () => {
		expect(enFrase('Pasos para Windows')).toBe('pasos para Windows');
		expect(enFrase('En un sensor')).toBe('en un sensor');
		expect(enFrase('Ésta')).toBe('ésta');
		expect(enFrase('')).toBe('');
	});
});
