/*
 * A dónde puede salir la consola cuando el destino lo escribe el cliente: el
 * webhook de eventos, el clonado de páginas y, a través de salidas/canales/red,
 * los canales de avisos y los conectores de respuesta. Pieza abierta: no
 * depende de nada de pago.
 *
 * Solo van a donde ha puesto el cliente, y nunca a:
 *
 *   - la propia máquina (127.0.0.0/8, ::1, 0.0.0.0) ni a una dirección de
 *     las interfaces de la consola: sería el propio nodo;
 *   - en Docker, el anfitrión (la puerta de enlace de cada red de la
 *     consola, host.docker.internal) ni los contenedores del nodo
 *     (postgres, sensor, Caddy…), por su nombre de compose
 *     (sugardaddy-postgres-1) o por su IP (mirarNodo): por ahí se llega a
 *     Postgres, a los puertos de salud, a la propia consola y a los puertos
 *     de las trampas. La IP del anfitrión en la red de la empresa sí vale
 *     (un recolector en esa misma máquina): desde dentro no se distingue de
 *     cualquier otra;
 *   - los servicios del propio nodo por su nombre (postgres, sensor…);
 *   - una dirección de enlace local (169.254.0.0/16, fe80::/10), que es
 *     donde están los metadatos de la nube y sus credenciales, ni los
 *     servicios internos de Azure (168.63.129.16), Alibaba (100.100.100.200)
 *     y AWS (fd00:ec2::254), tampoco escritas como IPv6 (::ffff:…, NAT64);
 *   - multidifusión ni direcciones reservadas.
 *
 * El nombre se resuelve antes de conectar y se conecta a la dirección ya
 * comprobada (no se vuelve a preguntar al DNS por el camino): si alguna de
 * las direcciones de un nombre está prohibida, no se usa ninguna. Sin cifrar
 * (syslog TCP o UDP, correo sin TLS) solo se sale a direcciones privadas, de
 * la red del cliente: lo que viaja lleva usuarios, contraseñas probadas y
 * comandos de los atacantes.
 *
 * Las redirecciones no se siguen: un webhook que redirige es un error que se
 * enseña, con la dirección final por poner.
 */
import { lookup, Resolver } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { rootCertificates, type SecureContextOptions } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

/*
 * Un error que se puede enseñar tal cual al cliente (sin secretos, sin rutas de
 * URL). codigo, si lo hay, es el de Node (CERT_HAS_EXPIRED…), para quien quiera
 * explicarlo a su manera.
 */
export class ErrorDestino extends Error {
	constructor(
		mensaje: string,
		readonly codigo?: string
	) {
		super(mensaje);
	}
}

/*
 * Solo en desarrollo y en las pruebas, nunca en una consola construida (dev
 * es una constante falsa al compilar): destinos en la propia máquina, CA de
 * prueba y nombres que apuntan a un servidor de prueba.
 */
export const pruebas: {
	destinosLocales: boolean;
	ca: string[];
	dns: Record<string, { ip: string; puerto?: number }>;
} = { destinosLocales: false, ca: [], dns: {} };
const locales = () => dev && (pruebas.destinosLocales || env.SALIDAS_DESTINOS_LOCALES === '1');

const v4 = (red: string, bits: number, l: BlockList) => l.addSubnet(red, bits, 'ipv4');
const v6 = (red: string, bits: number, l: BlockList) => l.addSubnet(red, bits, 'ipv6');

const MAQUINA = new BlockList();
v4('127.0.0.0', 8, MAQUINA);
v4('0.0.0.0', 8, MAQUINA);
MAQUINA.addAddress('::1', 'ipv6');
MAQUINA.addAddress('::', 'ipv6');

const ENLACE_LOCAL = new BlockList();
v4('169.254.0.0', 16, ENLACE_LOCAL);
v6('fe80::', 10, ENLACE_LOCAL);

const NUBE = new BlockList();
NUBE.addAddress('168.63.129.16', 'ipv4');
NUBE.addAddress('100.100.100.200', 'ipv4');
NUBE.addAddress('fd00:ec2::254', 'ipv6');

const RESERVADAS = new BlockList();
v4('224.0.0.0', 4, RESERVADAS);
v4('240.0.0.0', 4, RESERVADAS);
v6('ff00::', 8, RESERVADAS);

/* La red del cliente: lo único a lo que se puede mandar algo sin cifrar. */
const PRIVADAS = new BlockList();
v4('10.0.0.0', 8, PRIVADAS);
v4('172.16.0.0', 12, PRIVADAS);
v4('192.168.0.0', 16, PRIVADAS);
v4('100.64.0.0', 10, PRIVADAS);
v6('fc00::', 7, PRIVADAS);

/* Los servicios del propio nodo, como los nombra compose (despliegue/nodo/compose.yml). */
const SERVICIOS_DEL_NODO = new Set(['postgres', 'consola', 'sensor', 'https', 'actualizador']);
/* Sus contenedores (proyecto «sugardaddy»: sugardaddy-postgres-1) y el anfitrión de Docker o Podman. */
const CONTENEDOR_DEL_NODO = new RegExp(
	`^sugardaddy[-_](${[...SERVICIOS_DEL_NODO].join('|')})[-_]\\d+$`
);
const ANFITRION = /(^|\.)(docker|containers)\.internal$/;

/* Los ocho grupos de una IPv6 (con una IPv4 al final, si la lleva, en dos grupos). */
function grupos(ip6: string): number[] | null {
	let t = ip6.toLowerCase();
	const v4 = t.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) {
		const [a, b, c, d] = v4.slice(1).map(Number);
		t = `${t.slice(0, -v4[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [izq, der] = t.split('::');
	const a = izq ? izq.split(':') : [];
	const b = der ? der.split(':') : [];
	const todos = der === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
	const n = todos.map((x) => parseInt(x, 16));
	return n.length === 8 && n.every((x) => x >= 0 && x <= 0xffff) ? n : null;
}

/*
 * Una IPv6 que lleva dentro una IPv4 (::ffff:a.b.c.d, en cualquier forma, o
 * 64:ff9b::/96 de NAT64) es esa IPv4: así no se cuela la de los metadatos.
 */
function normalizar(ip: string): { ip: string; familia: 'ipv4' | 'ipv6' } {
	if (isIP(ip) !== 6) return { ip, familia: 'ipv4' };
	const g = grupos(ip);
	const mapeada = g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
	const nat64 = g && g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
	if (g && (mapeada || nat64))
		return { ip: [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.'), familia: 'ipv4' };
	return { ip, familia: 'ipv6' };
}

let propiasCache: { hasta: number; ips: Set<string> } | null = null;
/* Las direcciones de las interfaces de esta consola: las del propio nodo. */
function propias(): Set<string> {
	if (propiasCache && propiasCache.hasta > Date.now()) return propiasCache.ips;
	const ips = new Set<string>();
	for (const lista of Object.values(networkInterfaces()))
		for (const i of lista ?? []) ips.add(normalizar(i.address.split('%')[0]).ip.toLowerCase());
	propiasCache = { hasta: Date.now() + 60_000, ips };
	return ips;
}

/*
 * Lo del propio nodo que no está en las interfaces de la consola, solo si
 * corre en un contenedor (como en el nodo): la puerta de enlace de cada una
 * de sus redes, que es el anfitrión, y las IP de los contenedores del nodo.
 * Se mira al arrancar y, como mucho, cada minuto antes de enviar.
 */
export type FuentesNodo = {
	enContenedor: boolean;
	/* /proc/net/route. */
	rutas: string;
	/* Las direcciones de la consola con su máscara (os.networkInterfaces()). */
	interfaces: ReturnType<typeof networkInterfaces>;
	buscar: (nombre: string) => Promise<string[]>;
};

/* Las puertas de enlace de /proc/net/route (en hexadecimal y al revés: 010012AC es 172.18.0.1). */
export function puertasDeEnlace(rutas: string): string[] {
	const ips = new Set<string>();
	for (const l of rutas.split('\n').slice(1)) {
		const g = l.trim().split(/\s+/)[2];
		if (!g || !/^[0-9A-Fa-f]{8}$/.test(g) || /^0+$/.test(g)) continue;
		const n = parseInt(g, 16);
		ips.add([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24].join('.'));
	}
	return [...ips];
}

/* La primera dirección de cada red IPv4 de la consola: la que Docker da al anfitrión. */
export function primerasDeSusRedes(interfaces: FuentesNodo['interfaces']): string[] {
	const ips = new Set<string>();
	for (const lista of Object.values(interfaces))
		for (const i of lista ?? []) {
			if (i.internal || i.family !== 'IPv4') continue;
			const a = i.address.split('.').map(Number);
			const m = i.netmask.split('.').map(Number);
			const red = a.map((x, k) => x & m[k]);
			if (m[3] === 255) continue;
			red[3] += 1;
			ips.add(red.join('.'));
		}
	return [...ips];
}

const dnsNodo = new Resolver({ timeout: 1_000, tries: 1 });
const fuentesDelSistema = (): FuentesNodo => {
	const leer = (f: string) => {
		try {
			return readFileSync(f, 'utf8');
		} catch {
			return '';
		}
	};
	return {
		enContenedor: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
		rutas: leer('/proc/net/route'),
		interfaces: networkInterfaces(),
		async buscar(n) {
			const r = await Promise.allSettled([dnsNodo.resolve4(n), dnsNodo.resolve6(n)]);
			return r.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
		}
	};
};

let delNodo = new BlockList();
let delNodoHasta = 0;
let mirando: Promise<void> | null = null;

/* Vuelve a mirar lo del propio nodo (con fuentes, ya: para las pruebas). */
export function mirarNodo(fuentes?: FuentesNodo): Promise<void> {
	if (!fuentes && (Date.now() < delNodoHasta || locales())) return Promise.resolve();
	if (mirando && !fuentes) return mirando;
	const trabajo = (async () => {
		const f = fuentes ?? fuentesDelSistema();
		const l = new BlockList();
		if (f.enContenedor) {
			for (const ip of [...puertasDeEnlace(f.rutas), ...primerasDeSusRedes(f.interfaces)])
				l.addAddress(ip, 'ipv4');
			const servicios = await Promise.all([...SERVICIOS_DEL_NODO].map((n) => f.buscar(n)));
			for (const ip of servicios.flat()) {
				const x = normalizar(ip);
				if (isIP(x.ip)) l.addAddress(x.ip, x.familia);
			}
		}
		delNodo = l;
		delNodoHasta = Date.now() + 60_000;
	})().finally(() => {
		if (mirando === trabajo) mirando = null;
	});
	mirando = trabajo;
	return trabajo;
}

/* Por qué no se puede mandar nada a esta dirección; null si se puede. */
export function motivoIp(ip: string): string | null {
	const { ip: x, familia } = normalizar(ip.split('%')[0]);
	if (!isIP(x)) return `"${ip}" is not an IP address`;
	if (ENLACE_LOCAL.check(x, familia))
		return `${x} is a link-local address, like the one used for cloud metadata: nothing is sent there`;
	if (NUBE.check(x, familia)) return `${x} is an internal cloud service: nothing is sent there`;
	if (RESERVADAS.check(x, familia)) return `${x} is not a server address`;
	if (locales()) return null;
	if (MAQUINA.check(x, familia)) return `${x} is this same machine: enter the server's address`;
	if (propias().has(x.toLowerCase()) || delNodo.check(x, familia))
		return `${x} is the node itself: enter the server's address`;
	return null;
}

export const esPrivada = (ip: string) => {
	const { ip: x, familia } = normalizar(ip);
	return PRIVADAS.check(x, familia) || (locales() && MAQUINA.check(x, familia));
};

const NOMBRE =
	/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i;

/* Un nombre o una IP (IPv6 con o sin corchetes) sin los corchetes. */
export const sinCorchetes = (host: string) => host.replace(/^\[(.*)\]$/, '$1');

/*
 * Lo que se puede saber de un servidor sin preguntar al DNS: que se escribe
 * bien y que no es el propio nodo. null si vale.
 */
export function motivoHost(host: string): string | null {
	const h = sinCorchetes(host.trim());
	if (!h) return 'the server is missing';
	if (isIP(h)) return motivoIp(h);
	if (!NOMBRE.test(h)) return `"${host}" is not a valid server name`;
	const n = h.toLowerCase().replace(/\.$/, '');
	if (!locales() && (n === 'localhost' || n.endsWith('.localhost')))
		return `"${host}" is this same machine: enter the server's address`;
	if (SERVICIOS_DEL_NODO.has(n) || CONTENEDOR_DEL_NODO.test(n))
		return `"${host}" is a service of the node itself, not a server of yours`;
	if (!locales() && ANFITRION.test(n))
		return `"${host}" is the node's machine: enter the server's address`;
	return null;
}

export type Direccion = { address: string; family: 4 | 6 };

/*
 * Se pregunta al DNS con c-ares, con su plazo, y no con getaddrinfo: este
 * ocupa uno de los cuatro hilos que Node comparte con todo lo demás, y un DNS
 * del cliente que no contesta dejaría a la consola sin ellos. Lo que c-ares
 * no encuentra (no lee /etc/hosts ni otros servicios de nombres de la
 * máquina) se pregunta después al sistema. IPv4 primero.
 */
const dns = new Resolver({ timeout: 4_000, tries: 2 });
async function buscar(h: string): Promise<Direccion[]> {
	const [a, aaaa] = await Promise.allSettled([dns.resolve4(h), dns.resolve6(h)]);
	const dirs: Direccion[] = [
		...(a.status === 'fulfilled'
			? a.value.map((address) => ({ address, family: 4 as const }))
			: []),
		...(aaaa.status === 'fulfilled'
			? aaaa.value.map((address) => ({ address, family: 6 as const }))
			: [])
	];
	if (dirs.length) return dirs;
	const fallo = (a.status === 'rejected' ? a.reason : null) as NodeJS.ErrnoException | null;
	if (fallo?.code === 'ETIMEOUT') throw Object.assign(new Error('DNS'), { code: 'EDNSLENTO' });
	return (await lookup(h, { all: true, verbatim: true })) as Direccion[];
}

/*
 * Resuelve un servidor y comprueba cada dirección: si alguna está prohibida,
 * no se usa ninguna. Con sinCifrar, todas tienen que ser de la red del
 * cliente.
 */
export async function resolver(
	host: string,
	opciones: { sinCifrar?: boolean } = {}
): Promise<Direccion[]> {
	const h = sinCorchetes(host);
	await mirarNodo().catch(() => {});
	const m = motivoHost(h);
	if (m) throw new ErrorDestino(m);
	const prueba = dev ? pruebas.dns[h.toLowerCase()] : undefined;
	let dirs: Direccion[];
	if (prueba) dirs = [{ address: prueba.ip, family: isIP(prueba.ip) === 6 ? 6 : 4 }];
	else if (isIP(h)) dirs = [{ address: h, family: isIP(h) === 6 ? 6 : 4 }];
	else {
		try {
			dirs = await buscar(h);
		} catch (err) {
			throw new ErrorDestino(explicarError(err, h));
		}
		if (!dirs.length) throw new ErrorDestino(`"${h}" cannot be found in DNS`);
	}
	for (const d of dirs) {
		const motivo = motivoIp(d.address);
		if (motivo) throw new ErrorDestino(isIP(h) ? motivo : `"${h}" resolves to ${motivo}`);
		if (opciones.sinCifrar && !esPrivada(d.address))
			throw new ErrorDestino(
				`"${h}" (${d.address}) is not on your network: unencrypted traffic is only sent to private addresses. Use TLS.`
			);
	}
	return dirs;
}

/* El puerto de prueba que sustituye al de la URL (solo en las pruebas). */
export const puertoDePrueba = (host: string) =>
	dev ? pruebas.dns[sinCorchetes(host).toLowerCase()]?.puerto : undefined;

/*
 * Una CA en PEM (puede ser una cadena): null si vale, o por qué no. Solo
 * certificados, nunca una clave privada.
 */
export function motivoCa(pem: string): string | null {
	if (/PRIVATE KEY/.test(pem))
		return 'that is a private key: enter only the CA certificate, never its key';
	const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
	if (!certs?.length) return 'not a PEM certificate (-----BEGIN CERTIFICATE-----)';
	for (const c of certs)
		try {
			new X509Certificate(c);
		} catch {
			return 'one of the certificates cannot be read';
		}
	return null;
}

/* Las CA en las que se confía: las públicas de siempre más la del cliente, si la pone. */
export function confianza(ca?: unknown): Pick<SecureContextOptions, 'ca'> {
	const extra = [...(typeof ca === 'string' && ca.trim() ? [ca] : []), ...(dev ? pruebas.ca : [])];
	return extra.length ? { ca: [...rootCertificates, ...extra] } : {};
}

const CERTIFICADO_NO_CONFIABLE = new Set([
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'CERT_UNTRUSTED'
]);

/* ¿Falló porque el certificado no es de una CA de confianza o es de otro nombre? */
export const esCertificadoAjeno = (codigo?: string) =>
	!!codigo && (CERTIFICADO_NO_CONFIABLE.has(codigo) || codigo === 'ERR_TLS_CERT_ALTNAME_INVALID');

/*
 * La huella SHA-256 de un certificado, como la escribe Node (AB:CD:…): admite
 * que se pegue con o sin dos puntos, espacios o en minúsculas. null si no son
 * 32 bytes en hexadecimal.
 */
export function normalizarHuella(h: string): string | null {
	const x = h.replace(/[\s:]/g, '').toUpperCase();
	return /^[0-9A-F]{64}$/.test(x) ? x.match(/../g)!.join(':') : null;
}

/*
 * Un fallo de red en palabras del cliente. destino es lo que se puede
 * enseñar (servidor y puerto, nunca la ruta de una URL, que puede llevar el
 * token).
 */
export function explicarError(err: unknown, destino: string): string {
	if (err instanceof ErrorDestino) return err.message;
	const e = (err ?? {}) as NodeJS.ErrnoException & { reason?: string };
	const c = e.code ?? '';
	if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EAI_NONAME' || c === 'ENODATA')
		return `"${destino.replace(/:\d+$/, '')}" cannot be found in DNS`;
	if (c === 'EDNSLENTO')
		return `DNS does not respond when asked about "${destino.replace(/:\d+$/, '')}"`;
	if (c === 'ECONNREFUSED')
		return `${destino} refuses the connection: is it listening on that port?`;
	if (
		c === 'ETIMEDOUT' ||
		c === 'ESOCKETTIMEDOUT' ||
		c === 'ABORT_ERR' ||
		e.name === 'AbortError' ||
		e.name === 'TimeoutError'
	)
		return `${destino} is not responding`;
	if (c === 'ECONNRESET' || c === 'EPIPE') return `${destino} closed the connection`;
	if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return `no route to ${destino}`;
	if (CERTIFICADO_NO_CONFIABLE.has(c))
		return `the certificate of ${destino} is not from a trusted CA: if it comes from a private CA, enter its certificate under "CA"`;
	if (c === 'CERT_HAS_EXPIRED') return `the certificate of ${destino} has expired`;
	if (c === 'CERT_NOT_YET_VALID') return `the certificate of ${destino} is not valid yet`;
	if (c === 'ERR_TLS_CERT_ALTNAME_INVALID')
		return `the certificate of ${destino} was issued for a different name${e.reason ? ` (${e.reason})` : ''}`;
	if (c === 'EPROTO' || c.startsWith('ERR_SSL_') || c.startsWith('ERR_TLS_'))
		return `cannot establish TLS with ${destino}: is that port TLS?`;
	return `${destino}: ${String(e.message ?? err).slice(0, 200)}`;
}

/* Lo que dice el destino, para un error: corto y sin caracteres de control. */
export const extracto = (texto: string, max = 200) => {
	const t = texto
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.trim()
		.slice(0, max);
	return t ? `: "${t}"` : '';
};
