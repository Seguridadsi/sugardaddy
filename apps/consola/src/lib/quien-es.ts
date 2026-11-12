/*
 * Quién hay al otro lado de un evento, por lo que el honeypot ya guarda: el
 * User-Agent con que se presenta y la ruta que pide. Es una pista, no una
 * prueba: el User-Agent lo escribe el atacante y se cambia con una línea. Lo
 * único que no puede falsear es lo que dice el propio honeypot (agente-ia.ts).
 * Pura; no toca los honeypots ni la base.
 */
import { agenteIaDe } from './agente-ia';

export type ClaseQuien =
	| 'ia' /* un agente o un rastreador de IA */
	| 'ataque' /* una herramienta hecha para atacar o buscar fallos */
	| 'barrido' /* un servicio que recorre internet entero y lo cataloga */
	| 'programa' /* una biblioteca o un guion: alguien lo ha programado, no dice qué */
	| 'navegador';

export type Quien = { clase: ClaseQuien; nombre: string; motivo: string };

export const NOMBRE_CLASE: Record<ClaseQuien, string> = {
	ia: 'AI',
	ataque: 'Attack tool',
	barrido: 'Internet scanner',
	programa: 'Script',
	navegador: 'Browser'
};

type Regla = [RegExp, string];

/* Los agentes y rastreadores de IA que se anuncian con su nombre. */
const IA: Regla[] = [
	[/ChatGPT-User/i, 'ChatGPT'],
	[/OAI-SearchBot/i, 'OpenAI search'],
	[/GPTBot/i, 'OpenAI GPTBot'],
	[/Claude-User/i, 'Claude'],
	[/Claude-SearchBot|ClaudeBot|anthropic-ai/i, 'Anthropic ClaudeBot'],
	[/Perplexity-User|PerplexityBot/i, 'Perplexity'],
	[/MistralAI-User/i, 'Mistral'],
	[/Google-Extended|GoogleOther|Gemini-Deep-Research/i, 'Google AI'],
	[/meta-externalagent|meta-externalfetcher/i, 'Meta AI'],
	[/Amazonbot/i, 'Amazonbot'],
	[/Applebot-Extended/i, 'Apple AI'],
	[/Bytespider/i, 'Bytespider'],
	[/cohere-ai|cohere-training/i, 'Cohere'],
	[/DuckAssistBot/i, 'DuckAssist'],
	[/YouBot/i, 'You.com'],
	[/CCBot/i, 'Common Crawl'],
	[/Diffbot/i, 'Diffbot'],
	[/Manus-User/i, 'Manus'],
	[/browser-use|Stagehand|AgentQL/i, 'AI browser agent']
];

/* Herramientas de ataque y de búsqueda de fallos. */
const ATAQUE: Regla[] = [
	[/sqlmap/i, 'sqlmap'],
	[/nuclei/i, 'Nuclei'],
	[/Nmap Scripting Engine|\bnmap\b/i, 'Nmap'],
	[/nikto/i, 'Nikto'],
	[/WPScan/i, 'WPScan'],
	[/\bHydra\b/i, 'Hydra'],
	[/gobuster/i, 'Gobuster'],
	[/dirbuster/i, 'DirBuster'],
	[/Fuzz Faster U Fool|\bffuf\b/i, 'ffuf'],
	[/feroxbuster/i, 'feroxbuster'],
	[/wfuzz/i, 'Wfuzz'],
	[/dirsearch/i, 'dirsearch'],
	[/masscan/i, 'masscan'],
	[/zgrab/i, 'ZGrab'],
	[/acunetix/i, 'Acunetix'],
	[/nessus/i, 'Nessus'],
	[/openvas/i, 'OpenVAS'],
	[/qualys/i, 'Qualys'],
	[/metasploit|\bmsf\b/i, 'Metasploit'],
	[/Burp/i, 'Burp Suite'],
	[/\bZAP\b|OWASP/i, 'OWASP ZAP'],
	[/commix/i, 'commix'],
	[/httpx - Open-source project|projectdiscovery/i, 'ProjectDiscovery httpx'],
	[/WhatWeb/i, 'WhatWeb'],
	[/jndi:|\$\{|<script|\(\)\s*\{/i, 'Exploit in the User-Agent']
];

/* Servicios que recorren internet y lo catalogan. */
const BARRIDO: Regla[] = [
	[/Censys/i, 'Censys'],
	[/Shodan/i, 'Shodan'],
	[/Expanse|Palo Alto Networks/i, 'Palo Alto Xpanse'],
	[/InternetMeasurement/i, 'InternetMeasurement'],
	[/l9explore|l9tcpid|LeakIX/i, 'LeakIX'],
	[/BinaryEdge/i, 'BinaryEdge'],
	[/onyphe/i, 'ONYPHE'],
	[/NetcraftSurveyAgent/i, 'Netcraft'],
	[/Odin/i, 'Odin'],
	[/zmap/i, 'ZMap'],
	[/Googlebot|bingbot|YandexBot|Baiduspider|DuckDuckBot/i, 'Search engine crawler']
];

/* Bibliotecas y guiones: alguien lo ha programado. */
const PROGRAMA: Regla[] = [
	[/^curl\//i, 'curl'],
	[/^Wget\//i, 'Wget'],
	[/python-requests/i, 'Python requests'],
	[/python-httpx/i, 'Python httpx'],
	[/aiohttp/i, 'Python aiohttp'],
	[/Python-urllib|^Python\//i, 'Python'],
	[/Go-http-client/i, 'Go'],
	[/okhttp/i, 'OkHttp'],
	[/libwww-perl/i, 'Perl'],
	[/^Java\/|Apache-HttpClient/i, 'Java'],
	[/node-fetch|undici|axios|^node$/i, 'Node.js'],
	[/^Ruby|Faraday/i, 'Ruby'],
	[/PowerShell|WinHttp/i, 'PowerShell'],
	[/HeadlessChrome|PhantomJS|Playwright|Puppeteer|Selenium/i, 'Automated browser'],
	[/PostmanRuntime|insomnia/i, 'API client']
];

/* Rutas que solo pide quien trae una IA: las convenciones de los agentes y sus herramientas. */
const RUTAS_IA: Regla[] = [
	[/^\/llms(?:-full)?\.txt$/i, 'llms.txt'],
	[/^\/\.well-known\/ai-plugin\.json$/i, 'the AI plugin manifest'],
	[/^\/\.well-known\/(?:mcp|agent)(?:[./]|$)/i, 'the agent manifest'],
	[/^\/mcp(?:\/|$)/i, 'an MCP endpoint'],
	/* La dirección que solo nombra el AGENTS.md cebo (modulos/ficheros/fichero-tecnico-cebo). */
	[/\/agent-check$/i, 'the address that only a seeded AGENTS.md file mentions']
];

/* El programa con que entra por SSH, por la versión que anuncia (Cowrie la guarda en `version`). */
const SSH: [RegExp, ClaseQuien, string][] = [
	[/paramiko/i, 'programa', 'Python Paramiko'],
	[/AsyncSSH/i, 'programa', 'Python AsyncSSH'],
	[/libssh2?[_-]/i, 'programa', 'libssh'],
	[/^SSH-2\.0-Go\b/i, 'programa', 'Go'],
	[/JSCH|SSHJ|MINA|Maverick/i, 'programa', 'Java'],
	[/russh|thrussh/i, 'programa', 'Rust'],
	[/Nmap|NmapNSE/i, 'ataque', 'Nmap'],
	[/zgrab/i, 'ataque', 'ZGrab'],
	[/hydra|medusa|ncrack/i, 'ataque', 'Password cracker'],
	[/PuTTY|WinSCP|OpenSSH|dropbear|SecureCRT|Bitvise/i, 'navegador', 'Interactive SSH client']
];

const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const casa = (reglas: Regla[], t: string) => reglas.find(([r]) => r.test(t))?.[1] ?? null;

export function quienEs(detalle: Record<string, unknown> | null | undefined): Quien | null {
	/* Lo que dice el honeypot va por delante de lo que diga el atacante de sí mismo. */
	const dicho = agenteIaDe(detalle);
	if (dicho)
		return {
			clase: 'ia',
			nombre: 'AI agent',
			motivo:
				dicho === 'confirmed'
					? 'It followed a note written only for AI agents.'
					: 'It asked for a page that only a note written for AI agents points to.'
		};

	const ua = texto(detalle?.agente) || texto(detalle?.user_agent) || texto(detalle?.ua);
	const ruta = (texto(detalle?.ruta) || texto(detalle?.path)).split('?')[0];
	const como = `It presents itself as "${ua.slice(0, 120)}"; that text is chosen by whoever connects.`;

	const ia = ua ? casa(IA, ua) : null;
	if (ia) return { clase: 'ia', nombre: ia, motivo: como };
	const rutaIa = ruta ? casa(RUTAS_IA, ruta) : null;
	if (rutaIa)
		return {
			clase: 'ia',
			nombre: 'AI agent?',
			motivo: `It asked for ${rutaIa} (${ruta}), which AI agents and their tooling look for.`
		};
	/* SSH: no hay User-Agent; lo que hay es la versión del cliente. */
	const version = texto(detalle?.version);
	if (!ua && /^SSH-/i.test(version)) {
		const ssh = SSH.find(([r]) => r.test(version));
		if (!ssh) return null;
		return {
			clase: ssh[1],
			nombre: ssh[2],
			motivo: `Its SSH client presents itself as "${version.slice(0, 120)}"; that text is chosen by whoever connects.`
		};
	}
	if (!ua) return null;
	const ataque = casa(ATAQUE, ua);
	if (ataque) return { clase: 'ataque', nombre: ataque, motivo: como };
	const barrido = casa(BARRIDO, ua);
	if (barrido) return { clase: 'barrido', nombre: barrido, motivo: como };
	const programa = casa(PROGRAMA, ua);
	if (programa) return { clase: 'programa', nombre: programa, motivo: como };
	if (/^Mozilla\/\d/.test(ua) && /(Chrome|Firefox|Safari|Edg|OPR)\//.test(ua))
		return {
			clase: 'navegador',
			nombre: 'Browser',
			motivo: 'It presents itself as a web browser: a person, or a tool posing as one.'
		};
	return null;
}
