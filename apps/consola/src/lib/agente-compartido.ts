/*
 * El nombre de agente de IA que se comparte con la central (inteligencia.ts), a
 * partir de lo que dice quienEs. Solo del vocabulario cerrado del canal
 * (AGENTES_IA): el nombre que un cliente MCP diga de sí mismo, o cualquier otro
 * texto libre, se queda en «AI agent». Los rastreadores de IA (GPTBot, ClaudeBot…)
 * no se comparten: no atacan.
 */
import { AGENTES_IA } from '@sugardaddy/canal';
import { quienEs } from './quien-es';

const CONOCIDOS = new Set<string>(AGENTES_IA);

/* Los nombres de quienEs que no coinciden con el vocabulario. */
const EQUIVALE: Record<string, string> = {
	'CyberStrikeAI (webshell already planted)': 'CyberStrikeAI',
	'CyberStrike or PentestCode?': 'CyberStrike/PentestCode?',
	'CyberStrike or RedAmon?': 'CyberStrike/RedAmon?',
	'HexStrike (generated exploit)': 'HexStrike'
};

/* Los que dicen su nombre al pedir una página: rastreadores o asistentes, no agentes de ataque. */
const RASTREADORES = new Set([
	'ChatGPT',
	'OpenAI search',
	'OpenAI GPTBot',
	'Claude',
	'Anthropic ClaudeBot',
	'Perplexity',
	'Mistral',
	'Google AI',
	'Meta AI',
	'Amazonbot',
	'Apple AI',
	'Bytespider',
	'Cohere',
	'DuckAssist',
	'You.com',
	'Common Crawl',
	'Diffbot',
	'Manus',
	'AI browser agent'
]);

export function agenteCompartido(detalle: Record<string, unknown> | null | undefined) {
	const q = quienEs(detalle);
	if (q?.clase !== 'ia') return null;
	const nombre = EQUIVALE[q.nombre] ?? q.nombre;
	if (CONOCIDOS.has(nombre)) return nombre;
	if (RASTREADORES.has(nombre)) return null;
	/* Lo confirmó la trampa (nota para agentes, MCP) o es una pista sin nombre propio. */
	return nombre.endsWith('?') ? 'AI agent?' : 'AI agent';
}
