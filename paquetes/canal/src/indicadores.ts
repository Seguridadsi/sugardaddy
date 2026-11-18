/*
 * Inteligencia compartida entre clientes.
 *
 * Lo que sale de un nodo hacia el panel es lo mínimo para que otros clientes
 * se protejan, y nada que identifique al cliente ni a su gente:
 *
 * - solo IPs públicas: una IP privada no dice nada fuera de esa red y revela
 *   cómo es por dentro;
 * - solo con sesión TCP completa: un origen sin sesión puede estar falseado,
 *   y propagarlo sería dejar que un atacante elija a quién bloquean los demás;
 * - nunca lo que el cliente tiene en su lista blanca;
 * - sin usuarios, sin equipos, sin comandos, sin nombre del cliente.
 *
 * Y lo que baja es una lista firmada por el panel, con caducidad.
 */
import { isIP } from 'node:net';
import { createPrivateKey, sign } from 'node:crypto';
import { contenidaEn } from './rangos.ts';
import { motivoFirmas, type Firma } from './confianza.ts';
import { firmadoPorPanel } from './panel.ts';

export type IndicadorSubida = {
	valor: string;
	clase: 'ip';
	/* Qué tipo de trampa lo vio: ayuda a valorar, no identifica a nadie. */
	tipo: 'contenedor' | 'fichero' | 'token' | 'identidad';
	primeraVez: string;
	eventos: number;
	/*
	 * Qué módulos de trampa la vieron (cowrie, rdp…), para saber el servicio
	 * atacado. El módulo, nunca el nombre de la trampa: ese lo pone el cliente o
	 * sale de su dominio, y diría de quién es. Opcional: los nodos anteriores a
	 * la 0.26 no lo mandan.
	 */
	modulos?: string[];
	/*
	 * 'tcp': la IP completó la conexión con la trampa (el nodo solo sube esas). El panel solo
	 * cuenta para el umbral de propagación los avistamientos que lo dicen
	 * (docs/diseno/frenos-del-nodo.md). Opcional: los nodos anteriores no lo mandan, y sus
	 * avistamientos se guardan pero no propagan.
	 */
	conexion?: 'tcp';
	/*
	 * Qué agente de IA de ataque se reconoció en esa IP (ARTEX, CyberStrike…), con «?»
	 * cuando es pista y no prueba. Solo nombres de AGENTES_IA: nada de texto libre, ni
	 * lo que el atacante diga de sí mismo. Opcional: los nodos anteriores no lo mandan.
	 */
	agentes?: string[];
	/*
	 * Las técnicas de MITRE ATT&CK que se vieron en esa IP (T1110, T1046…), del mapeo de
	 * «Qué hacer ahora» (@sugardaddy/contrato/que-hacer-ahora): solo ids de ese vocabulario,
	 * que el panel vuelve a comprobar. Opcional: los nodos anteriores no lo mandan, y el
	 * panel deduce lo que puede de sus módulos.
	 */
	tecnicas?: string[];
};

/* El vocabulario cerrado de agentes que se comparten. Los rastreadores de IA (GPTBot…) no. */
export const AGENTES_IA = [
	'AI agent',
	'AI agent?',
	'ARTEX',
	'ARTEX?',
	'CyberStrike',
	'CyberStrike/RedAmon?',
	'CyberStrikeAI',
	'PentestCode',
	'CyberStrike/PentestCode?',
	'PentAGI?',
	'HexStrike',
	'RedAmon',
	'CAI?',
	'Claude Code',
	'Gemini CLI'
] as const;
const AGENTES = new Set<string>(AGENTES_IA);

/* Los agentes que se aceptan: del vocabulario, sin repetir. */
export function agentesValidos(x: unknown): string[] {
	if (!Array.isArray(x)) return [];
	return [...new Set(x.filter((a): a is string => typeof a === 'string' && AGENTES.has(a)))].sort();
}

export const MAXIMO_MODULOS = 10;
const MODULO = /^[a-z0-9][a-z0-9-]{0,40}$/;

/* Los módulos que se aceptan: identificadores de módulo, sin repetir, como mucho 10. */
export function modulosValidos(x: unknown): string[] {
	if (!Array.isArray(x)) return [];
	return [...new Set(x.filter((m): m is string => typeof m === 'string' && MODULO.test(m)))]
		.sort()
		.slice(0, MAXIMO_MODULOS);
}

export type IndicadorGlobal = {
	valor: string;
	clase: 'ip' | 'red' | 'hash';
	motivo: string;
	caduca: string;
};

export type ListaGlobal = {
	version: 1;
	/*
	 * Desde la 0.32, dentro de lo firmado: una lista de Tor o un estado deseado, firmados con la
	 * misma clave del panel, no pasan por lista global. Opcional porque los paneles anteriores
	 * no lo mandan (verificarLista la acepta como `legado` si tiene forma de lista global); los
	 * nodos anteriores lo ignoran.
	 */
	tipo?: typeof TIPO_LISTA_GLOBAL;
	emitida: string;
	caduca: string;
	indicadores: IndicadorGlobal[];
};

export const TIPO_LISTA_GLOBAL = 'global';

/* firmas: las de las claves nuevas del panel (panel.ts). */
export type ListaFirmada = { lista: string; firma: string; firmas?: Firma[] };

/* Rangos que no se comparten nunca: privados, internos, documentación, multicast. */
const NO_PUBLICAS_V4: [number, number][] = [
	[0x00000000, 8],
	[0x0a000000, 8],
	[0x64400000, 10],
	[0x7f000000, 8],
	[0xa9fe0000, 16],
	[0xac100000, 12],
	[0xc0000000, 24],
	[0xc0000200, 24],
	[0xc0a80000, 16],
	[0xc6120000, 15],
	[0xc6336400, 24],
	[0xcb007100, 24],
	[0xe0000000, 4],
	[0xf0000000, 4]
];

const aEntero = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

export function esIpPublica(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) {
		const n = aEntero(ip);
		return !NO_PUBLICAS_V4.some(([red, bits]) => n >>> (32 - bits) === red >>> (32 - bits));
	}
	if (v === 6) {
		/* Solo unicast global (2000::/3), y fuera el rango de documentación
		 * (2001:db8::/32). Se mira el PRIMER HEXTETO, no el primer carácter del
		 * texto: 2:: es 0002::, reservado, no global. */
		return contenidaEn(ip, ['2000::/3']) && !contenidaEn(ip, ['2001:db8::/32']);
	}
	return false;
}

/* Contención y resta de IPs y redes (IPv4 e IPv6): en rangos.ts. */
export { aCidrs, contenidaEn, rango, restar } from './rangos.ts';

/* ---------- la lista global, firmada por el panel ---------- */

const privada = (b64: string) =>
	createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });

export function firmarLista(clavePrivada: string, l: ListaGlobal): ListaFirmada {
	const texto = JSON.stringify(l);
	return {
		lista: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64')
	};
}

/* Lo que se lee del texto firmado, sin lanzar: un objeto o nada. */
function objetoDe(texto: string): Record<string, unknown> | null {
	try {
		const o = JSON.parse(texto);
		return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
	} catch {
		return null;
	}
}

/* Una fecha de caducidad que no se lee (NaN) no puede valer para siempre. */
const caducada = (caduca: unknown, ahora: number) => {
	const t = typeof caduca === 'string' ? Date.parse(caduca) : NaN;
	return !Number.isFinite(t) || t < ahora;
};

export function verificarLista(
	clavesPanel: string | readonly string[],
	f: ListaFirmada,
	ahora = Date.now()
): { ok: true; lista: ListaGlobal; legado: boolean } | { ok: false; motivo: string } {
	const valida =
		!!f &&
		typeof f.lista === 'string' &&
		!motivoFirmas(f.firmas) &&
		firmadoPorPanel(clavesPanel, f.lista, f.firma, f.firmas);
	if (!valida) return { ok: false, motivo: 'list not signed by Central' };
	const o = objetoDe(f.lista);
	/*
	 * Con tipo, el suyo. Sin tipo (un panel anterior a la 0.32), solo si tiene forma de lista
	 * global: la de Tor ya llevaba el suyo y un estado deseado no trae `indicadores`.
	 */
	if (!o || (o.tipo !== undefined ? o.tipo !== TIPO_LISTA_GLOBAL : !Array.isArray(o.indicadores)))
		return { ok: false, motivo: 'not a global list' };
	const l = o as unknown as ListaGlobal;
	if (l.version !== 1) return { ok: false, motivo: 'unknown list version' };
	if (caducada(l.caduca, ahora)) return { ok: false, motivo: 'list expired' };
	return { ok: true, lista: l, legado: l.tipo === undefined };
}

/* ---------- nodos de salida de Tor, firmados por el panel ---------- */

/*
 * La lista pública del Tor Project, tal como la descargó el panel. Lleva
 * "tipo" para que una firma de esta lista no pueda hacerse pasar por la de
 * otra cosa firmada con la misma clave. Caduca sola: si el panel deja de
 * renovarla, los nodos dejan de usar una lista vieja.
 */
export type ListaTor = {
	version: 1;
	tipo: 'tor';
	fuente: string;
	emitida: string;
	caduca: string;
	ips: string[];
};

export function firmarListaTor(clavePrivada: string, l: ListaTor): ListaFirmada {
	const texto = JSON.stringify(l);
	return {
		lista: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64')
	};
}

export function verificarListaTor(
	clavesPanel: string | readonly string[],
	f: ListaFirmada,
	ahora = Date.now()
): { ok: true; lista: ListaTor } | { ok: false; motivo: string } {
	const valida =
		!!f &&
		typeof f.lista === 'string' &&
		!motivoFirmas(f.firmas) &&
		firmadoPorPanel(clavesPanel, f.lista, f.firma, f.firmas);
	if (!valida) return { ok: false, motivo: 'list not signed by Central' };
	const l = objetoDe(f.lista) as ListaTor | null;
	if (!l || l.version !== 1 || l.tipo !== 'tor') return { ok: false, motivo: 'not a Tor list' };
	if (caducada(l.caduca, ahora)) return { ok: false, motivo: 'list expired' };
	if (!Array.isArray(l.ips) || l.ips.some((ip) => !isIP(ip)))
		return { ok: false, motivo: 'the list contains something that is not an IP' };
	return { ok: true, lista: l };
}
