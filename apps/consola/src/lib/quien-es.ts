/*
 * Quién hay al otro lado de un evento, por lo que el honeypot ya guarda. Es una
 * pista, no una prueba. De menos a más difícil de falsear:
 *
 *  - Lo que dice de sí mismo: el User-Agent, la versión del cliente SSH y la ruta
 *    que pide. Lo escribe el atacante y se cambia con una línea.
 *  - Cómo saluda: la huella TLS (`ja4`, `ja3`) y la de SSH (`hassh`). La escribe
 *    la biblioteca con que está hecho el programa. Un guion de Python que dice
 *    ser Chrome sigue saludando como Python: esa contradicción es lo que delata.
 *  - A qué ritmo escribe (`ritmo`, al cerrar una sesión de SSH): las manos
 *    teclean de una en una; un programa manda la línea entera.
 *  - Lo que dice el propio honeypot (agente-ia.ts): eso no lo falsea.
 *
 * Las huellas conocidas están en quien-es-huellas.ts. Pura; no toca los
 * honeypots ni la base.
 */
import { agenteIaDe } from './agente-ia';
import { OOB, clienteMcpDe, marcaDe, textoDelAtacante } from './quien-es-agentes';
import {
	HASSH,
	huellaTlsDe,
	leerJa4,
	type FamiliaTls,
	type HuellaSsh,
	type HuellaTls
} from './quien-es-huellas';

export type ClaseQuien =
	| 'ia' /* un agente o un rastreador de IA */
	| 'ataque' /* una herramienta hecha para atacar o buscar fallos */
	| 'barrido' /* un servicio que recorre internet entero y lo cataloga */
	| 'programa' /* una biblioteca o un guion: alguien lo ha programado, no dice qué */
	| 'persona' /* alguien tecleando a mano */
	| 'navegador';

export type Quien = { clase: ClaseQuien; nombre: string; motivo: string };

export const NOMBRE_CLASE: Record<ClaseQuien, string> = {
	ia: 'AI',
	ataque: 'Attack tool',
	barrido: 'Internet scanner',
	programa: 'Script',
	persona: 'Person',
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
	[/browser-use|Stagehand|AgentQL/i, 'AI browser agent'],
	/* Datadog lo vio en ataques reales contra AWS: artex-pentest/1.0, Mozilla/5.0 ARTeX…; Dragos (19-nov-2026): artex-agent, artex-judge-r121. */
	[/\bart[e3]x\b/i, 'ARTEX'],
	/* Elastic lo vio en ataques de ARTEX (13-nov-2026): norma/0.4. */
	[/^norma\/\d/i, 'ARTEX'],
	/*
	 * Agent Zero descarga documentos con el User-Agent por defecto de la librería de
	 * mixedbread (helpers/network.py). Otras herramientas pueden usar el mismo: pista.
	 */
	[/^@mixedbread-ai\/unstructured$/i, 'Agent Zero?'],
	/* El gestor de webshells de CyberStrikeAI: si llega, ya hay una webshell dentro. */
	[/CyberStrikeAI-WebShell/i, 'CyberStrikeAI (webshell already planted)'],
	/* CyberStrike y PentestCode repiten con su nombre a secas tras un reto de Cloudflare. */
	[/^cyberstrike$/i, 'CyberStrike'],
	[/^pentestcode$/i, 'PentestCode'],
	/* HexStrike AI: su cliente HTTP, su navegador y la plantilla de los exploits que fabrica. */
	[/HexStrike/i, 'HexStrike'],
	[/^Mozilla\/5\.0 \(Compatible Exploit\)$/i, 'HexStrike (generated exploit)'],
	/* RedAmon: RedAmon-AISurfaceRecon/1.0, RedAmon-CachePoison/1.0, Mozilla/5.0 (compatible; RedAmon/4.7)… */
	[/RedAmon/i, 'RedAmon']
];

/*
 * Asistentes de línea de órdenes que leen páginas por encargo. Un usuario legítimo
 * genera la misma cadena: solo cuenta contra administración, APIs o inicios de sesión.
 */
const CLI_IA: Regla[] = [
	[/Claude-User \(claude-cli\//i, 'Claude Code'],
	[/Google-Gemini-CLI/i, 'Gemini CLI']
];
const RUTA_SENSIBLE =
	/^\/(?:admin|api|login|signin|wp-|administrator|manager|console|dashboard|auth)/i;

/* CAI (Alias Robotics) lee páginas como «Chrome/124.0 Safari/537.36»: un Chrome real manda cuatro números. */
const UA_CAI = /Chrome\/124\.0 Safari\//;

/*
 * La cadena de Chrome cortada tras «AppleWebKit/537.36», sin «(KHTML, like Gecko)
 * Chrome/… Safari/…»: ningún navegador la manda. Es la del implante de CyberStrikeAI
 * y la de la exfiltración de CyberStrike (sale del código, no de ataques vistos).
 */
const UA_CORTADO = /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36$/;

/* El Chrome 143 en Windows con que se disfrazan CyberStrike y PentestCode al leer páginas. */
const UA_CHROME_143 =
	/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/143\.0\.0\.0 Safari\/537\.36$/;

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
	[/^\/\.well-known\/ai-catalog\.json$/i, 'the AI catalog'],
	/* La dirección que solo nombra el AGENTS.md cebo (modulos/ficheros/fichero-tecnico-cebo). */
	[/\/agent-check$/i, 'the address that only a seeded AGENTS.md file mentions']
];

/*
 * El programa con que entra por SSH, por la versión que anuncia (Cowrie la guarda
 * en `version`). El último elemento es la familia de su huella (HASSH), para
 * comparar lo que dice con cómo negocia; vacío si no hay con qué comparar.
 */
/*
 * La página inventada que ARTEX pide para ver cómo responde el servidor a un 404
 * antes de lanzar el fuzzing (Datadog vio /zzz-nonexistent-xyz123, y en S3 las claves
 * zzz_nonexistent_abc.txt y Notexist-xyz).
 */
/* Y las que da MalwareMustDie (MMD-072-2026): /zz-notexist-*, /artx-nonexistent, /artx2909-zzq7. */
const PRUEBA_404_ARTEX =
	/zzz[-_]?non-?exist|\/zz-notexist|artx-nonexistent|artx2909-zzq7|notexist-xyz/i;
/* Lo mismo sin la marca de ARTEX: también lo hacen otros escáneres, por eso va detrás de ellos. */
const PRUEBA_404 = /non-?existent|not-?exist/i;

/* Lo que ARTEX deja al entrar: ficheros artex-probe-12345, C:\ProgramData\artx5v\, cuentas ArtexProbe. */
const MARCAS_ARTEX = /artex-probe-\d{5}|artx5v|ArtexProbe/i;

const SSH: [RegExp, ClaseQuien, string, string][] = [
	[/paramiko/i, 'programa', 'Python Paramiko', 'paramiko'],
	[/AsyncSSH/i, 'programa', 'Python AsyncSSH', 'asyncssh'],
	[/libssh2[_-]/i, 'programa', 'libssh', 'libssh2'],
	[/libssh[_-]/i, 'programa', 'libssh', 'libssh'],
	[/^SSH-2\.0-Go\b/i, 'programa', 'Go', 'go'],
	[/JSCH/i, 'programa', 'Java', 'jsch'],
	[/SSHJ|MINA|Maverick/i, 'programa', 'Java', ''],
	[/russh|thrussh/i, 'programa', 'Rust', ''],
	[/Twisted/i, 'programa', 'Python Twisted', 'twisted'],
	[/Ruby\/Net::SSH/i, 'programa', 'Ruby Net::SSH', 'netssh'],
	[/Nmap|NmapNSE/i, 'ataque', 'Nmap', 'nmap'],
	[/zgrab/i, 'ataque', 'ZGrab', ''],
	/* Medusa se anuncia con su nombre y negocia con libssh2. */
	[/medusa/i, 'ataque', 'Password cracker', 'libssh2'],
	[/hydra|ncrack/i, 'ataque', 'Password cracker', ''],
	[/OpenSSH/i, 'navegador', 'Interactive SSH client', 'openssh'],
	[/PuTTY|WinSCP/i, 'navegador', 'Interactive SSH client', 'putty'],
	[/dropbear/i, 'navegador', 'Interactive SSH client', 'dropbear'],
	[/SecureCRT|Bitvise/i, 'navegador', 'Interactive SSH client', '']
];

const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const numero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const casa = (reglas: Regla[], t: string) => reglas.find(([r]) => r.test(t))?.[1] ?? null;

/* Lo que hay que decir siempre que se habla de una huella. */
const PISTA = 'A hint, not proof';
const POR_QUE_TLS =
	'The name is free text; the handshake comes from the library the program is built with.';
const SALVEDAD_TLS = `${PISTA}: a proxy that re-encrypts the connection changes the handshake too.`;

/* ---- El ritmo de una sesión de SSH (Cowrie, al cerrarla) ---- */

function porRitmo(detalle: Record<string, unknown>): Quien | null {
	const ritmo = texto(detalle.ritmo);
	const teclas = numero(detalle.teclas_ms);
	const borrados = numero(detalle.borrados) ?? 0;
	const ordenes = numero(detalle.ordenes);
	const intervalo = numero(detalle.intervalo_ms);
	const desviacion = numero(detalle.intervalo_desv_ms);
	if (ritmo === 'human')
		return {
			clase: 'persona',
			nombre: 'Person typing',
			motivo:
				`Keystrokes arrived one at a time${teclas === null ? '' : `, typically ${teclas} ms apart`}` +
				`${borrados > 0 ? `, with ${borrados} ${borrados === 1 ? 'correction' : 'corrections'}` : ''}: ` +
				`the pace of someone typing by hand. ${PISTA}.`
		};
	if (ritmo === 'agent') {
		const maximo = numero(detalle.intervalo_max_ms);
		return {
			clase: 'ia',
			nombre: 'AI agent?',
			motivo:
				`${ordenes === null ? 'Commands' : `${ordenes} commands`} arrived as whole lines` +
				`${intervalo === null ? '' : `, typically ${(intervalo / 1000).toFixed(1)} s apart`}` +
				`${maximo === null ? '' : ` and never more than ${(maximo / 1000).toFixed(1)} s`}, at an uneven pace: ` +
				`a model reading each answer and deciding the next step, with none of the pauses of a person. ${PISTA}.`
		};
	}
	if (ritmo === 'pasted')
		return {
			clase: 'programa',
			nombre: 'Pasted or scripted input',
			motivo:
				`Whole lines arrived at once${teclas === null ? '' : ` (keystrokes typically ${teclas} ms apart)`}: ` +
				`pasted, or sent by a program. ${PISTA}.`
		};
	if (ritmo === 'scripted') {
		const cuantas = ordenes === null ? 'Commands' : `${ordenes} commands`;
		const regular = intervalo !== null && intervalo > 500;
		return {
			clase: 'programa',
			nombre: 'Scripted session',
			motivo:
				(intervalo === null
					? `${cuantas} arrived one right after another`
					: regular
						? `${cuantas} arrived at regular intervals of about ${intervalo} ms${desviacion === null ? '' : ` (±${desviacion} ms)`}`
						: `${cuantas} arrived typically ${intervalo} ms apart`) +
				`: sent by a program, not typed. ${PISTA}.`
		};
	}
	return null;
}

/* ---- SSH: lo que anuncia el cliente y cómo negocia (HASSH) ---- */

function porSsh(version: string, hassh: string): Quien | null {
	const dicho = /^SSH-/i.test(version) ? (SSH.find(([r]) => r.test(version)) ?? null) : null;
	const huella: HuellaSsh | null = HASSH[hassh.toLowerCase()] ?? null;
	const anuncia = `Its SSH client presents itself as "${version.slice(0, 120)}"`;
	if (!huella) {
		if (!dicho) return null;
		return {
			clase: dicho[1],
			nombre: dicho[2],
			motivo: `${anuncia}; that text is chosen by whoever connects.`
		};
	}
	const negocia = `it negotiates encryption the way ${huella.nombre} does (HASSH ${hassh.toLowerCase()})`;
	const clase: ClaseQuien =
		huella.clase === 'ataque' ? 'ataque' : huella.clase === 'cliente' ? 'navegador' : 'programa';
	/* Sin versión (o con una que no es de SSH), queda la huella. */
	if (!/^SSH-/i.test(version))
		return {
			clase,
			nombre: huella.clase === 'cliente' ? 'Interactive SSH client' : huella.nombre,
			motivo: `No client name to compare, but ${negocia}. ${PISTA}.`
		};
	/* Dice una cosa y negocia como otra: la contradicción. */
	if (dicho && dicho[3] && dicho[3] !== huella.familia)
		return {
			clase: clase === 'navegador' ? 'programa' : clase,
			nombre: `${huella.nombre} posing as ${dicho[2] === 'Interactive SSH client' ? nombreSsh(version) : dicho[2]}`,
			motivo:
				`${anuncia}, but ${negocia}. The name is free text; the negotiation comes from ` +
				`the library the program is built with. ${PISTA}.`
		};
	/* Lo que dice y cómo negocia casan, o no hay con qué comparar lo que dice. */
	if (dicho)
		return {
			clase: huella.clase === 'ataque' ? 'ataque' : dicho[1],
			nombre: dicho[2],
			motivo: `${anuncia} and ${negocia}. ${PISTA}: both can be imitated.`
		};
	return {
		clase,
		nombre: huella.clase === 'cliente' ? 'Interactive SSH client' : huella.nombre,
		motivo: `${anuncia}, a name that says little; ${negocia}. ${PISTA}.`
	};
}

/* «OpenSSH», «PuTTY»… de «SSH-2.0-OpenSSH_9.6»: lo que va tras la versión del protocolo. */
function nombreSsh(version: string): string {
	return /^SSH-[\d.]+-([A-Za-z]+)/.exec(version)?.[1] ?? 'an interactive client';
}

/* ---- TLS: lo que dice el User-Agent y cómo saluda (JA4, JA3) ---- */

type Tls = { huella: HuellaTls | null; cual: string; ja4: ReturnType<typeof leerJa4> };

function tlsDe(detalle: Record<string, unknown>): Tls | null {
	const ja4 = texto(detalle.ja4).toLowerCase();
	const ja3 = texto(detalle.ja3).toLowerCase();
	const leido = leerJa4(ja4);
	if (!leido && !/^[0-9a-f]{32}$/.test(ja3)) return null;
	return {
		huella: huellaTlsDe(leido ? ja4 : '', ja3),
		cual: leido ? `JA4 ${ja4}` : `JA3 ${ja3}`,
		ja4: leido
	};
}

/* El navegador que dice ser un User-Agent, y la familia de TLS que le toca. */
function navegadorDe(ua: string): { nombre: string; familia: FamiliaTls } | null {
	if (!/^Mozilla\/\d/.test(ua) || !/(Chrome|Firefox|Safari|Edg|OPR)\//.test(ua)) return null;
	/* En iPhone y iPad todos los navegadores van con el motor y la red de Apple. */
	if (/iPhone|iPad|iPod/.test(ua)) return { nombre: 'Safari', familia: 'apple' };
	if (/Firefox\//.test(ua)) return { nombre: 'Firefox', familia: 'firefox' };
	if (/(Chrome|Chromium|Edg|OPR)\//.test(ua)) return { nombre: 'Chrome', familia: 'chromium' };
	return { nombre: 'Safari', familia: 'apple' };
}

/* La familia de TLS que le toca a una biblioteca que se anuncia con su nombre. */
const TLS_DE_PROGRAMA: Record<string, FamiliaTls[]> = {
	'Python requests': ['python'],
	'Python httpx': ['python'],
	'Python aiohttp': ['python'],
	Python: ['python'],
	Go: ['go'],
	'Node.js': ['node'],
	Java: ['java'],
	PowerShell: ['dotnet'],
	'Automated browser': ['chromium', 'firefox', 'apple']
};

/* Una frase más para el motivo: cómo saluda, cuando se sabe de quién es el saludo. */
const yTls = (tls: Tls | null) =>
	tls?.huella ? ` Its TLS handshake is the one ${tls.huella.nombre} produces (${tls.cual}).` : '';

/* Dice ser una cosa y saluda como otra. */
function contradiccionTls(ua: string, dice: string, tls: Tls & { huella: HuellaTls }): Quien {
	return {
		clase: tls.huella.tipo === 'ataque' ? 'ataque' : 'programa',
		nombre: `${tls.huella.nombre} posing as ${dice}`,
		motivo:
			`It presents itself as "${ua.slice(0, 120)}", but its TLS handshake is the one ` +
			`${tls.huella.nombre} produces (${tls.cual}). ${POR_QUE_TLS} ${SALVEDAD_TLS}`
	};
}

/*
 * Sin huella conocida, la primera parte de JA4 ya dice si puede ser un navegador:
 * todos los de hoy ofrecen TLS 1.3 y HTTP/2. Devuelve por qué no lo es, o null.
 */
function noEsNavegador(ja4: NonNullable<Tls['ja4']>): string | null {
	if (ja4.version !== null && ja4.version < 13)
		return `it offers TLS ${ja4.version === 12 ? '1.2' : ja4.version === 11 ? '1.1' : '1.0'} at most, and every current browser offers TLS 1.3`;
	if (ja4.alpn === '00') return 'it does not offer HTTP/2, and every current browser does';
	return null;
}

/* Un framework de ataque con IA, por una marca que deja (quien-es-agentes.ts). */
function porMarca(detalle: Record<string, unknown>, ua: string): Quien | null {
	const hallada = marcaDe(ua, textoDelAtacante(detalle), clienteMcpDe(detalle));
	if (!hallada) return null;
	const { marca, visto } = hallada;
	const duda = marca.agente.endsWith('?');
	return {
		clase: 'ia',
		nombre: marca.agente,
		motivo:
			`It carries "${visto}", ${marca.que}. ` +
			`${duda ? `${PISTA}: other tools can send it too.` : `${PISTA}: the mark can be copied.`}`
	};
}

/* Una carga que llama a un dominio de pruebas a ciegas (interactsh, Burp Collaborator…). */
function porOob(detalle: Record<string, unknown>): Quien | null {
	const m = OOB.exec(textoDelAtacante(detalle));
	if (!m) return null;
	return {
		clase: 'ataque',
		nombre: 'Blind injection test',
		motivo:
			`It carries ${m[0].slice(0, 80)}, an out-of-band testing domain (interactsh, Burp Collaborator, dnslog): ` +
			`a payload that calls that domain if it runs, used by AI attack agents and classic scanners alike.`
	};
}

export function quienEs(detalle: Record<string, unknown> | null | undefined): Quien | null {
	const q = quienEsBase(detalle);
	/* La prueba a ciegas dice más que «un guion» o «un navegador», y menos que una herramienta con nombre. */
	if (detalle && (!q || q.clase === 'programa' || q.clase === 'navegador'))
		return porOob(detalle) ?? q;
	return q;
}

function quienEsBase(detalle: Record<string, unknown> | null | undefined): Quien | null {
	/* Lo que dice el honeypot va por delante de lo que diga el atacante de sí mismo. */
	const dicho = agenteIaDe(detalle);
	if (dicho) {
		/*
		 * La herramienta que el honeypot reconoce por cómo se porta (reto_agentes.go
		 * de las trampas web): tras un reto falso de Cloudflare (CyberStrike,
		 * PentestCode) o por la doble carga (PentAGI). La escribe el honeypot, no el
		 * atacante; si es solo sospecha, el nombre lleva la duda.
		 */
		const herramienta = texto(detalle?.herramienta_ia).slice(0, 80);
		if (herramienta)
			return {
				clase: 'ia',
				nombre: dicho === 'confirmed' ? herramienta : `${herramienta}?`,
				motivo:
					texto(detalle?.motivo).slice(0, 400) ||
					(dicho === 'confirmed'
						? `The honeypot recognised ${herramienta} by how it behaves, not by what it says about itself.`
						: `It behaves like ${herramienta}. ${PISTA}.`)
			};
		/* Una marca de un framework conocido le pone nombre al agente. */
		const marca = detalle
			? porMarca(detalle, texto(detalle.agente) || texto(detalle.user_agent))
			: null;
		if (marca) return marca;
		/* El cliente MCP se presenta al hablar el protocolo (portal-agentes): da nombre al agente. */
		const mcp = detalle ? clienteMcpDe(detalle) : '';
		if (mcp)
			return {
				clase: 'ia',
				nombre: mcp,
				motivo: `It spoke the MCP protocol, which only AI agents and their tooling use, and introduced itself as "${mcp}"; that name is chosen by whoever connects.`
			};
		return {
			clase: 'ia',
			nombre: 'AI agent',
			motivo:
				dicho === 'confirmed'
					? 'It followed a note written only for AI agents.'
					: 'It asked for a page that only a note written for AI agents points to.'
		};
	}
	if (!detalle) return null;

	const ua = texto(detalle.agente) || texto(detalle.user_agent) || texto(detalle.ua);
	const ruta = (texto(detalle.ruta) || texto(detalle.path)).split('?')[0];
	const tls = tlsDe(detalle);
	const como = `It presents itself as "${ua.slice(0, 120)}"; that text is chosen by whoever connects.`;

	const marca = porMarca(detalle, ua);
	if (marca) return marca;
	/*
	 * La trampa mcp (H54) guarda el clientInfo pero no marca agente_ia: hablar MCP ya
	 * dice que al otro lado hay un agente de IA o sus herramientas.
	 */
	const mcp = clienteMcpDe(detalle);
	if (mcp)
		return {
			clase: 'ia',
			nombre: mcp,
			motivo: `It spoke the MCP protocol, which only AI agents and their tooling use, and introduced itself as "${mcp}"; that name is chosen by whoever connects.`
		};

	const cli = ua ? casa(CLI_IA, ua) : null;
	if (cli && RUTA_SENSIBLE.test(ruta))
		return {
			clase: 'ia',
			nombre: cli,
			motivo: `${como} It is the page reader of ${cli}, an AI coding assistant, sent against ${ruta.slice(0, 80)}: an operator pointing an AI agent at an admin page, API or login. A legitimate user can send the same string. ${PISTA}.`
		};
	const ia = ua ? casa(IA, ua) : null;
	if (ia) return { clase: 'ia', nombre: ia, motivo: como + yTls(tls) };
	const orden = texto(detalle.input);
	if (orden && MARCAS_ARTEX.test(orden))
		return {
			clase: 'ia',
			nombre: 'ARTEX',
			motivo: `Its command leaves a mark the ARTEX attack agent was seen leaving (${orden.match(MARCAS_ARTEX)![0]}). ${PISTA}: the name can be copied.`
		};
	if (ruta && PRUEBA_404_ARTEX.test(ruta))
		return {
			clase: 'ia',
			nombre: 'ARTEX?',
			motivo: `It asked for a made-up page (${ruta.slice(0, 120)}) to see how the server answers a missing page, the probe the ARTEX attack agent was seen making before fuzzing. ${PISTA}.`
		};
	const rutaIa = ruta ? casa(RUTAS_IA, ruta) : null;
	if (rutaIa)
		return {
			clase: 'ia',
			nombre: 'AI agent?',
			motivo: `It asked for ${rutaIa} (${ruta}), which AI agents and their tooling look for.`
		};
	if (!ua) {
		/* SSH: no hay User-Agent; lo que hay es la versión del cliente y su huella. */
		const version = texto(detalle.version);
		const hassh = texto(detalle.hassh);
		if (/^SSH-/i.test(version) || /^[0-9a-f]{32}$/i.test(hassh)) return porSsh(version, hassh);
		/* El cierre de una sesión de SSH, con su ritmo. */
		const ritmo = porRitmo(detalle);
		if (ritmo) return ritmo;
		/* Una conexión TLS sin petición (un túnel por SSH, un saludo suelto): queda el saludo. */
		if (tls?.huella)
			return {
				clase:
					tls.huella.tipo === 'ataque'
						? 'ataque'
						: tls.huella.tipo === 'navegador'
							? 'navegador'
							: 'programa',
				nombre: tls.huella.nombre,
				motivo: `Its TLS handshake is the one ${tls.huella.nombre} produces (${tls.cual}). ${SALVEDAD_TLS}`
			};
		return null;
	}
	if (UA_CORTADO.test(ua))
		return {
			clase: 'ia',
			nombre: 'CyberStrike or RedAmon?',
			motivo: `It presents itself as "${ua}", a Chrome string cut short that no browser sends; it is the one the CyberStrikeAI implant, CyberStrike's exfiltration and the RedAmon crawler use. ${PISTA}.`
		};
	if (UA_CAI.test(ua))
		return {
			clase: 'ia',
			nombre: 'CAI?',
			motivo: `It presents itself as "${ua.slice(0, 120)}": Chrome with a two-part version, which no real Chrome sends (it always sends four, 124.0.0.0). It is the page reader of the CAI AI agent. ${PISTA}.`
		};
	if (ua === 'Mozilla/5.0')
		return {
			clase: 'programa',
			nombre: 'Script posing as a browser',
			motivo: `It presents itself only as "Mozilla/5.0", which no browser sends alone; some recon scripts of the CyberStrike AI agent do. ${PISTA}.`
		};
	const ataque = casa(ATAQUE, ua);
	if (ataque) return { clase: 'ataque', nombre: ataque, motivo: como + yTls(tls) };
	const barrido = casa(BARRIDO, ua);
	if (barrido) return { clase: 'barrido', nombre: barrido, motivo: como + yTls(tls) };
	if (ruta && PRUEBA_404.test(ruta))
		return {
			clase: 'ia',
			nombre: 'AI agent?',
			motivo: `It asked for a made-up page (${ruta.slice(0, 120)}) to see how the server answers a missing page before probing, as AI attack agents such as ARTEX do. ${como} ${PISTA}.`
		};
	const programa = casa(PROGRAMA, ua);
	if (programa) {
		const toca = TLS_DE_PROGRAMA[programa];
		if (tls?.huella && toca && !toca.includes(tls.huella.familia))
			return contradiccionTls(ua, programa, { ...tls, huella: tls.huella });
		return { clase: 'programa', nombre: programa, motivo: como + yTls(tls) };
	}
	const navegador = navegadorDe(ua);
	if (navegador) {
		/* CyberStrike va con Bun (misma lista de cifrados que Firefox, medido con Bun 1.4) y PentestCode con Bun o Node. */
		if (tls?.huella && tls.huella.familia !== 'chromium' && UA_CHROME_143.test(ua))
			return {
				clase: 'ia',
				nombre: 'CyberStrike or PentestCode?',
				motivo:
					`It presents itself as Chrome 143 on Windows, but its TLS handshake is the one ${tls.huella.nombre} produces (${tls.cual}): ` +
					`the exact disguise the CyberStrike and PentestCode AI agents use to read web pages. ${SALVEDAD_TLS}`
			};
		if (tls?.huella && tls.huella.familia !== navegador.familia)
			return contradiccionTls(ua, navegador.nombre, { ...tls, huella: tls.huella });
		if (tls?.huella)
			return {
				clase: 'navegador',
				nombre: 'Browser',
				motivo:
					`It presents itself as a web browser and its TLS handshake is the one ${tls.huella.nombre} ` +
					`produces (${tls.cual}): a person, or an automated browser.`
			};
		const pega = tls?.ja4 ? noEsNavegador(tls.ja4) : null;
		if (pega)
			return {
				clase: 'programa',
				nombre: `Script posing as ${navegador.nombre}`,
				motivo:
					`It presents itself as "${ua.slice(0, 120)}", but ${pega} (${tls!.cual}). ` +
					`${POR_QUE_TLS} ${SALVEDAD_TLS}`
			};
		return {
			clase: 'navegador',
			nombre: 'Browser',
			motivo: 'It presents itself as a web browser: a person, or a tool posing as one.'
		};
	}
	return null;
}
