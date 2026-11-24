/*
 * Las marcas que dejan los frameworks de ataque llevados por agentes de IA, para
 * nombrarlos en un evento. Salen de ThreatDefence agentic-attack-detections
 * (https://github.com/ThreatDefence/agentic-attack-detections, commit cf360e5,
 * iocs/indicators.csv y los source-code-signals.md de cada framework). Licencia MIT,
 * Copyright (c) 2026 ThreatDefence Pty Ltd and contributors. Ver
 * docs/diseno/agentes-ataque-threatdefence.md.
 *
 * Solo entran las de confianza alta: cadenas que salen del código del framework o que
 * un informe publicó, y que nadie más manda. Lo de confianza media lleva «?» en el
 * nombre. Los nombres son del vocabulario cerrado AGENTES_IA (paquetes/canal).
 *
 * Dónde se busca:
 *  - `ua`: el User-Agent.
 *  - `texto`: cualquier texto que la trampa guarde del atacante (ruta, consulta,
 *    cuerpo, petición en crudo, orden de una shell, prompt, argumentos…). Ninguna trampa
 *    guarda aparte las cabeceras, pero las que guardan la petición en crudo sí las
 *    llevan: por eso los nombres de cabecera van aquí.
 *  - `mcp`: el nombre con que se presenta un cliente MCP (clientInfo).
 *
 * Pura; no toca los honeypots ni la base.
 */

export type DondeMarca = 'ua' | 'texto' | 'mcp';

export type Marca = {
	donde: DondeMarca;
	patron: RegExp;
	agente: string;
	/* Qué es esa marca, en inglés: sale tal cual en el motivo. */
	que: string;
};

export const MARCAS_AGENTES: Marca[] = [
	/* ---- ARTEX y su copia AntiFox ---- */
	{
		donde: 'ua',
		patron: /scopeweaver|spa-api-recon/i,
		agente: 'ARTEX',
		que: 'a user agent of renamed ARTEX consoles'
	},
	{
		donde: 'ua',
		patron: /antifox/i,
		agente: 'AntiFox',
		que: 'the AntiFox (renamed ARTEX) user agent'
	},
	{
		donde: 'texto',
		patron:
			/ARTEX_WRITE_PROBE|ARTX_PERSIST_OK|artex_control_marker_zz9q|ARTEX-PROBE-\d{4}|%ARTEX_PROBE_UNSET%|### ARTX-AGENT/i,
		agente: 'ARTEX',
		que: 'a marker ARTEX agents write to label their own work'
	},
	{
		donde: 'texto',
		patron: /callback\?code=AAAA&state=notvalidb64!!/i,
		agente: 'ARTEX',
		que: 'the OAuth callback probe ARTEX sends'
	},
	{
		donde: 'texto',
		/* El JWT exacto, sin firmar, con test@test.com, que ARTEX roció por las rutas de SSO. */
		patron: /eyJhbGciOiJub25lIn0\.eyJlbWFpbCI6InRlc3RAdGVzdC5jb20ifQ\./,
		agente: 'ARTEX',
		que: 'the unsigned JWT ARTEX sprays across sign-in routes'
	},
	{
		donde: 'texto',
		/* MalwareMustDie (MMD-072-2026) da X-ARTX-KEY por confirmada (T1). */
		patron: /x-artx-key/i,
		agente: 'ARTEX',
		que: 'the request header of the ARTEX web shell'
	},
	{
		donde: 'texto',
		patron: /x-artex-replay-nonce/i,
		agente: 'ARTEX?',
		que: 'a request header of the ARTEX traffic replay'
	},
	{
		donde: 'texto',
		patron:
			/\[\[ARTEX_DATA nonce=|<<<UNTRUSTED_OUTPUT|Untrusted data rule \(code-owned\):|artex-data-marker-removed/,
		agente: 'ARTEX',
		que: 'fixed text of the prompts ARTEX sends to its model'
	},
	{
		donde: 'mcp',
		patron: /^artex\b/i,
		agente: 'ARTEX',
		que: 'the MCP client name ARTEX uses with remote MCP servers'
	},

	/*
	 * Del paquete MMD-072-2026 de MalwareMustDie (Detection Rule License 1.1,
	 * «MalwareMustDie.org - @unixfreaxjp», github.com/unixfreaxjp/malwaremustdie, commit
	 * 43f7946b, etc/artex-stix-osquery-sigma-kql-snort-suricata-yara): sus marcas T1 y
	 * los nombres de fichero T2 anclados.
	 */
	{
		donde: 'ua',
		patron: /ArtExVerify\//i,
		agente: 'ARTEX',
		que: 'the user agent ARTEX uses to check a WAF bypass'
	},
	{
		donde: 'texto',
		patron: /[?&]k=x9f3c2b7e(?![\w])/,
		agente: 'ARTEX',
		que: 'the key parameter of the ARTEX web shell'
	},
	{
		donde: 'texto',
		patron:
			/\bzzartx\d+\.php\b|(?:^|[\s/\\"'=])artx[_-][\w.-]*\.(?:php\d?|phtml|aspx?|ashx|jspx?)\b/i,
		agente: 'ARTEX',
		que: 'a web shell file name ARTEX uploads'
	},
	{
		donde: 'texto',
		patron: /INTO\s+OUTFILE\s+['"`]?\/tmp\/x\.php5/i,
		agente: 'ARTEX',
		que: 'the database write of a web shell ARTEX makes'
	},
	{
		donde: 'texto',
		patron: /LOAD\s+DATA\s+LOCAL\s+INFILE[\s\S]{0,300}?\bartx_\w+/i,
		agente: 'ARTEX',
		que: 'a file ARTEX loads into an artx_ table'
	},
	{
		donde: 'texto',
		/*
		 * Datadog Security Labs, «On the hunt for ARTEX» (2026-11-09): al darse de alta en
		 * Cognito con un dominio de empresa inventado, hxxps://artex-hqheizfk.invalid/x.
		 */
		patron: /\bartex-[a-z0-9]{8}\.invalid\b/i,
		agente: 'ARTEX',
		que: 'the made-up tenant domain ARTEX sends when it signs up'
	},

	/* ---- HexStrike ---- */
	{
		donde: 'texto',
		patron: /hexstrikeXSSTest123/i,
		agente: 'HexStrike',
		que: 'the reflection probe the HexStrike browser agent puts in forms'
	},
	{
		donde: 'texto',
		patron: /\/tmp\/hexstrike_(?:files|envs)/,
		agente: 'HexStrike',
		que: 'a HexStrike working folder'
	},
	{
		donde: 'mcp',
		patron: /hexstrike/i,
		agente: 'HexStrike',
		que: 'the HexStrike MCP client name'
	},

	/* ---- CyberStrikeAI ---- */
	{
		donde: 'ua',
		patron: /^CyberStrikeAI\/\d/i,
		agente: 'CyberStrikeAI',
		que: 'the CyberStrikeAI console user agent'
	},
	{
		donde: 'texto',
		patron: /:OSPROBE_/,
		agente: 'CyberStrikeAI',
		que: 'the operating system probe the CyberStrikeAI web shell manager runs'
	},
	{
		donde: 'texto',
		patron: /x-implant-token/i,
		agente: 'CyberStrikeAI',
		que: 'the header every CyberStrikeAI implant request carries'
	},
	{
		donde: 'texto',
		/*
		 * Kaspersky Securelist, «CyberStrikeAI attacks educational institutions»
		 * (2026-11-02): el implante disfrazado de svchost, el script troceado que se
		 * decodifica con certutil y el fichero donde copian la cadena DSN de Reporting
		 * Services. Son de los operadores, no del código: con «?».
		 */
		patron: /\bsvchosts\.exe\b|\bd3\.b64\b|\bdsn_line\.txt\b/i,
		agente: 'CyberStrikeAI?',
		que: 'a file name Kaspersky saw CyberStrikeAI operators use'
	},
	{
		donde: 'texto',
		patron: /&>\/dev\/null &\) # cs\b|cyberstrike-ai\/tmp\/c2\/payloads\/build-/,
		agente: 'CyberStrikeAI',
		que: 'the persistence line or build path of a CyberStrikeAI implant'
	},

	/* ---- RedAmon ---- */
	{
		donde: 'texto',
		patron: /rEdAm0n1337XsS|redamon-poc\.invalid/i,
		agente: 'RedAmon',
		que: 'a RedAmon canary (XSS or cache poisoning)'
	},
	{
		donde: 'mcp',
		patron: /RedAmon/i,
		agente: 'RedAmon',
		que: 'the MCP client name of the RedAmon AI surface probe'
	},

	/* ---- Xalgorix ---- */
	{
		donde: 'ua',
		patron: /xalgorix/i,
		agente: 'Xalgorix',
		que: 'the Xalgorix user agent'
	},
	{
		donde: 'texto',
		patron:
			/xalgorix-(?:nonexistent|missing|xxe)-|x-xalgorix-origin-calibration|__xalgorix_resolve_path|xalgorix-oob-ok:/i,
		agente: 'Xalgorix',
		que: 'a marker the Xalgorix verifier sends'
	},

	/* ---- Pentest Swarm AI ---- */
	{
		donde: 'texto',
		patron:
			/evil\.pentestswarm\.invalid|vV9x-nonexistent-9271|<!DOCTYPE pstest \[|nx_nonexistent_zzq/i,
		agente: 'Pentest Swarm',
		que: 'a check value Pentest Swarm AI sends'
	},
	{
		donde: 'ua',
		patron: /pentestswarm/i,
		agente: 'Pentest Swarm?',
		que: 'the Pentest Swarm AI user agent'
	},

	/* ---- PentAGI ---- */
	{
		donde: 'texto',
		patron:
			/read -r adj 2>\/dev\/null <\/proc\/self\/oom_score_adj|pentagi-terminal-|operating within a fully authorized penetration testing system|TOOL CALL WORKFLOW ENFORCER/,
		agente: 'PentAGI',
		que: 'the command wrapper, worker name or fixed prompt text of PentAGI'
	},

	/* ---- Cairn ---- */
	{
		donde: 'texto',
		patron:
			/cairn-dispatch-|\/tmp\/cairn-(?:prompts|pi)\/|TSEC_AGENT_TOKEN|TSEC_SERVER_HOST|under no circumstances should you reject; you are expected to handle|This is the conclude phase|Fact-graph based collaborative exploration protocol/,
		agente: 'Cairn',
		que: 'a worker name, folder, variable or fixed prompt text of Cairn'
	},

	/* ---- Strix ---- */
	{
		donde: 'texto',
		patron:
			/strix-run-id|caido-cli --listen 0\.0\.0\.0:48080|phc_7rO3XRuNT5sgSKAl6HDIrWdSGh1COzxw0vxVIAR6vVZ/,
		agente: 'Strix',
		que: 'a sandbox label, proxy command or telemetry key of Strix'
	},

	/*
	 * ---- Los del informe de GitGuardian «AI pentesting tools beyond ARTEX» (2026-11-09):
	 * cadenas sacadas del código de cada uno (docs/diseno/agentes-ataque-gitguardian.md).
	 * Las copias de ARTEX ScopeWeaver, FORANG y ycode conservan «spa-api-recon» (regla de
	 * ARTEX de arriba); Pojun la quitó y no deja nada propio.
	 */
	{
		donde: 'ua',
		patron: /Cybermes[/-]/i,
		agente: 'Cybermes',
		que: 'the Cybermes crawler, prober or fuzzer user agent'
	},
	{
		donde: 'ua',
		patron: /FORANG-DirScan/,
		agente: 'FORANG',
		que: 'the directory scanner user agent of FORANG (renamed ARTEX)'
	},
	{
		donde: 'ua',
		patron: /^YCode-recon\//i,
		agente: 'ycode',
		que: 'the ycode (renamed ARTEX) recon user agent'
	},
	{
		donde: 'ua',
		patron: /^cyber$|\(compatible; cyber\/1\.0;/,
		agente: 'cyber-harness',
		que: 'the user agent of the cyber-harness probes'
	},
	{
		donde: 'ua',
		patron: /T3MP3ST/,
		agente: 'T3MP3ST',
		que: 'the T3MP3ST user agent'
	},
	{
		donde: 'ua',
		patron: /^pensar-apex$|PensarBot\//i,
		agente: 'Pensar Apex',
		que: 'the user agent Pensar Apex puts on its attack requests'
	},
	{
		donde: 'ua',
		patron: /LuaN1aoAgent\//i,
		agente: 'LuaN1aoAgent',
		que: 'the LuaN1aoAgent page reader user agent'
	},
	{
		donde: 'ua',
		/* Un Chrome de 2021 en Linux: el navegador de AIRecon. Hay quien no actualiza: pista. */
		patron:
			/X11; Linux x86_64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/91\.0\.4472\.124 Safari/,
		agente: 'AIRecon?',
		que: 'the 2021 Linux Chrome the AIRecon browser presents'
	},
	{
		donde: 'texto',
		patron: /file:\s*sandcat\.go|splunkd -server \S+ -group red|becomeUserAgent\.sh/,
		agente: 'Incalmo',
		que: 'the command Incalmo runs to drop its Caldera agent (sandcat as «splunkd»)'
	},
	{
		donde: 'texto',
		patron: /default-placeholder-key-change-in-production/,
		agente: 'virga',
		que: 'the default key of a virga implant (a C2 with a local model inside)'
	},

	/* ---- Hermes Agent como consola de ataque ---- */
	{
		donde: 'texto',
		patron:
			/HERMES_YOLO_MODE|SOUL - Red Team Operator|You are GH0ST|CARBONATO_API_KEY|\/\.hermes\/(?:loot|skills\/security\/godmode)\//,
		agente: 'Hermes Agent',
		que: 'an approval switch, attack persona or folder of Hermes Agent turned into an attack console'
	},
	{
		donde: 'texto',
		/* El contenedor que la botnet Carbonato crea por una API de Docker expuesta. */
		patron: /\bnetns-probe\b/,
		agente: 'Hermes Agent?',
		que: 'the container name the Carbonato botnet (Hermes Agent) creates through an exposed Docker API'
	}
];

/*
 * Dominios de las pruebas a ciegas (interactsh, Burp Collaborator, dnslog): una carga
 * que, si se ejecuta, llama a uno de ellos. No nombra a un agente: la usan los agentes y
 * los escáneres de siempre.
 */
export const OOB =
	/\b[\w.-]*\.(?:oast\.(?:fun|pro|live|site|online|me)|interact\.sh|interactsh\.com|oastify\.com|burpcollaborator\.net|dnslog\.cn)\b/i;

/* Las claves del detalle que escribe la propia trampa: no son del atacante. */
const DE_LA_TRAMPA = new Set(['motivo', 'herramienta_ia', 'agente_ia']);

/* Todo el texto que la trampa guarda del atacante, acotado. */
export function textoDelAtacante(detalle: Record<string, unknown>): string {
	const partes: string[] = [];
	let total = 0;
	const meter = (v: unknown, hondo: number) => {
		if (total > 16_384 || hondo > 4) return;
		if (typeof v === 'string') {
			partes.push(v);
			total += v.length;
		} else if (Array.isArray(v)) for (const x of v) meter(x, hondo + 1);
		else if (v && typeof v === 'object') for (const x of Object.values(v)) meter(x, hondo + 1);
	};
	for (const [k, v] of Object.entries(detalle)) if (!DE_LA_TRAMPA.has(k)) meter(v, 0);
	return partes.join('\n');
}

/*
 * El nombre con que se presenta un cliente MCP. portal-agentes lo guarda ya como
 * «nombre versión» en `cliente_mcp`; la trampa mcp guarda el clientInfo en crudo
 * (JSON, quizá recortado) en `clientinfo`.
 */
export function clienteMcpDe(detalle: Record<string, unknown>): string {
	const dicho = typeof detalle.cliente_mcp === 'string' ? detalle.cliente_mcp.trim() : '';
	if (dicho) return dicho.slice(0, 80);
	const crudo = typeof detalle.clientinfo === 'string' ? detalle.clientinfo.trim() : '';
	if (!crudo) return '';
	const nombre = /"name"\s*:\s*"([^"\\]{1,80})/.exec(crudo)?.[1]?.trim() ?? '';
	const version = /"version"\s*:\s*"([^"\\]{1,40})/.exec(crudo)?.[1]?.trim() ?? '';
	if (nombre) return `${nombre}${version ? ` ${version}` : ''}`.slice(0, 80);
	/* Sin JSON legible: lo que haya, sin comillas ni llaves. */
	return crudo.replace(/[{}"]/g, '').slice(0, 80);
}

export type MarcaEncontrada = { marca: Marca; visto: string };

/* La primera marca que casa, con el trozo que la delata. */
export function marcaDe(ua: string, texto: string, mcp: string): MarcaEncontrada | null {
	for (const marca of MARCAS_AGENTES) {
		const donde = marca.donde === 'ua' ? ua : marca.donde === 'mcp' ? mcp : texto;
		if (!donde) continue;
		const m = marca.patron.exec(donde);
		if (m) return { marca, visto: m[0].slice(0, 80) };
	}
	return null;
}
