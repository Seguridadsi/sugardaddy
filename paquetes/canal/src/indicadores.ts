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
import { sign, verify } from 'node:crypto';
import { createPrivateKey, createPublicKey } from 'node:crypto';

export type IndicadorSubida = {
	valor: string;
	clase: 'ip';
	/* Qué tipo de trampa lo vio: ayuda a valorar, no identifica a nadie. */
	tipo: 'contenedor' | 'fichero' | 'token' | 'identidad';
	primeraVez: string;
	eventos: number;
};

export type IndicadorGlobal = {
	valor: string;
	clase: 'ip' | 'red' | 'hash';
	motivo: string;
	caduca: string;
};

export type ListaGlobal = {
	version: 1;
	emitida: string;
	caduca: string;
	indicadores: IndicadorGlobal[];
};

export type ListaFirmada = { lista: string; firma: string };

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
		const x = ip.toLowerCase();
		/* Solo unicast global (2000::/3), y fuera el rango de documentación. */
		return /^[23]/.test(x) && !x.startsWith('2001:db8') && !x.startsWith('2001:0db8');
	}
	return false;
}

/* Contención y resta de IPs y redes (IPv4 e IPv6): en rangos.ts. */
export { contenidaEn, restar } from './rangos.ts';

/* ---------- la lista global, firmada por el panel ---------- */

const privada = (b64: string) =>
	createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
const publica = (b64: string) =>
	createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

export function firmarLista(clavePrivada: string, l: ListaGlobal): ListaFirmada {
	const texto = JSON.stringify(l);
	return {
		lista: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64')
	};
}

export function verificarLista(
	clavePublicaPanel: string,
	f: ListaFirmada,
	ahora = Date.now()
): { ok: true; lista: ListaGlobal } | { ok: false; motivo: string } {
	let valida = false;
	try {
		valida = verify(
			null,
			Buffer.from(f.lista),
			publica(clavePublicaPanel),
			Buffer.from(f.firma, 'base64')
		);
	} catch {
		valida = false;
	}
	if (!valida) return { ok: false, motivo: 'lista no firmada por el panel' };
	const l = JSON.parse(f.lista) as ListaGlobal;
	if (l.version !== 1) return { ok: false, motivo: 'versión de lista desconocida' };
	if (Date.parse(l.caduca) < ahora) return { ok: false, motivo: 'lista caducada' };
	return { ok: true, lista: l };
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
	clavePublicaPanel: string,
	f: ListaFirmada,
	ahora = Date.now()
): { ok: true; lista: ListaTor } | { ok: false; motivo: string } {
	let valida = false;
	try {
		valida = verify(
			null,
			Buffer.from(f.lista),
			publica(clavePublicaPanel),
			Buffer.from(f.firma, 'base64')
		);
	} catch {
		valida = false;
	}
	if (!valida) return { ok: false, motivo: 'lista no firmada por el panel' };
	const l = JSON.parse(f.lista) as ListaTor;
	if (l.version !== 1 || l.tipo !== 'tor') return { ok: false, motivo: 'no es una lista de Tor' };
	if (Date.parse(l.caduca) < ahora) return { ok: false, motivo: 'lista caducada' };
	if (!Array.isArray(l.ips) || l.ips.some((ip) => !isIP(ip)))
		return { ok: false, motivo: 'la lista trae algo que no es una IP' };
	return { ok: true, lista: l };
}
