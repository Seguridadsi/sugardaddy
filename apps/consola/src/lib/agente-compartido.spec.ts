import { describe, expect, it } from 'vitest';
import { AGENTES_IA } from '@sugardaddy/canal';
import { agenteCompartido } from './agente-compartido';

describe('el agente de IA que se comparte', () => {
	it.each([
		[{ agente: 'artex-pentest/1.0' }, 'ARTEX'],
		[{ agente: 'python-requests/2.31.0', ruta: '/zzz-nonexistent-xyz123' }, 'ARTEX?'],
		[{ agente: 'Mozilla/5.0 (compatible; CyberStrikeAI-WebShell/1.0)' }, 'CyberStrikeAI'],
		[{ agente: 'pentestcode' }, 'PentestCode'],
		[{ agente_ia: 'confirmed', cliente_mcp: 'evil "agent"\n' }, 'AI agent'],
		[{ agente: 'curl/8', ruta: '/llms.txt' }, 'AI agent?'],
		[{ agente: 'Mozilla/5.0 (Compatible Exploit)' }, 'HexStrike'],
		[{ ritmo: 'agent', ordenes: 7, intervalo_ms: 2000 }, 'AI agent?'],
		[{ agente_ia: 'confirmed', herramienta_ia: 'PentestCode' }, 'PentestCode'],
		[{ agente_ia: 'suspected', herramienta_ia: 'PentAGI' }, 'PentAGI?'],
		[
			{ agente: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
			'CyberStrike/RedAmon?'
		],
		[{ agente: 'Claude-User (claude-cli/2.1.325)', ruta: '/admin' }, 'Claude Code']
	])('%j → %s', (detalle, nombre) => {
		expect(agenteCompartido(detalle)).toBe(nombre);
		expect(AGENTES_IA).toContain(nombre);
	});

	it('ni rastreadores ni lo que no es IA', () => {
		expect(agenteCompartido({ agente: 'Mozilla/5.0 (compatible; GPTBot/1.2)' })).toBeNull();
		expect(agenteCompartido({ agente: 'sqlmap/1.8' })).toBeNull();
		expect(
			agenteCompartido({ agente: 'Claude-User (claude-cli/2.1.325)', ruta: '/blog' })
		).toBeNull();
		expect(agenteCompartido(null)).toBeNull();
	});
});

describe('los frameworks nuevos se comparten con su nombre', () => {
	it.each([
		[{ ruta: '/?q=hexstrikeXSSTest123' }, 'HexStrike'],
		[{ agente: '@mixedbread-ai/unstructured', ruta: '/' }, 'Agent Zero?'],
		[{ agente: 'norma/0.4', ruta: '/' }, 'ARTEX'],
		[{ input: 'export HERMES_YOLO_MODE=1' }, 'Hermes Agent'],
		[{ ruta: '/a/xalgorix-missing-1/x' }, 'Xalgorix'],
		[{ clientinfo: '{"name":"some-agent","version":"1"}' }, 'AI agent']
	])('%o', (detalle, nombre) => {
		expect(agenteCompartido(detalle)).toBe(nombre);
	});
});
