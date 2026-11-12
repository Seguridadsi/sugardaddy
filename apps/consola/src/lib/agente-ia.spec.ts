import { describe, expect, it } from 'vitest';
import { agenteIaDe } from './agente-ia';

describe('la marca de agente de IA de un evento', () => {
	it('solo vale lo que dice el honeypot con sus dos valores', () => {
		expect(agenteIaDe({ agente_ia: 'suspected' })).toBe('suspected');
		expect(agenteIaDe({ agente_ia: 'confirmed' })).toBe('confirmed');
		expect(agenteIaDe({ agente_ia: 'yes' })).toBeNull();
		expect(agenteIaDe({ agente_ia: true })).toBeNull();
		expect(agenteIaDe({})).toBeNull();
		expect(agenteIaDe(null)).toBeNull();
	});
});
