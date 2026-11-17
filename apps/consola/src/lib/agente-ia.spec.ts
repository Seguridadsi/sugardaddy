import { describe, expect, it } from 'vitest';
import { QUE_ES_AGENTE, agenteIaDe, etiquetaAgente, queEsAgente } from './agente-ia';

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

describe('la herramienta que reconoce el honeypot', () => {
	it('da nombre a la etiqueta, con la duda si es sospecha', () => {
		expect(etiquetaAgente({ agente_ia: 'confirmed', herramienta_ia: 'CyberStrike' })).toBe(
			'AI agent: CyberStrike'
		);
		expect(etiquetaAgente({ agente_ia: 'suspected', herramienta_ia: 'PentAGI' })).toBe(
			'AI agent? PentAGI'
		);
		expect(etiquetaAgente({ agente_ia: 'confirmed' })).toBe('AI agent');
		expect(etiquetaAgente({ herramienta_ia: 'CyberStrike' })).toBeNull();
	});

	it('cambia la explicación de la nota por la de la herramienta', () => {
		expect(queEsAgente({ agente_ia: 'confirmed' })).toBe(QUE_ES_AGENTE.confirmed);
		expect(queEsAgente({ agente_ia: 'confirmed', herramienta_ia: 'PentestCode' })).toContain(
			'PentestCode'
		);
		expect(queEsAgente({ agente_ia: 'suspected', herramienta_ia: 'PentAGI' })).toContain(
			'not proof'
		);
		expect(queEsAgente({})).toBeNull();
	});
});
