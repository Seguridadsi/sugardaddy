/*
 * La exportación completa de la consola (Ajustes → Export, docs/negocio/plan-de-salida.md):
 * las piezas que no tocan la base de datos, aparte para probarlas solas.
 *
 *   - Un .tar.gz que se escribe sobre la marcha. El tar necesita el tamaño de cada
 *     fichero antes de su contenido, así que cada tabla grande sale en trozos de
 *     unos MiB (events/events-0001.jsonl, -0002…): la memoria tiene tope, no hay
 *     ficheros temporales en el disco del nodo y la descarga empieza enseguida.
 *   - JSON Lines (una fila por línea, tal cual la guarda la base, sin los secretos)
 *     y CEF para los eventos, con los mismos campos que salen al SIEM
 *     (docs/siem-cef-leef.md).
 *   - Un manifiesto con el SHA-256 de cada fichero, firmado con la clave del nodo
 *     (la Ed25519 de su canal con el panel; un nodo Community, HMAC con
 *     CLAVE_SECRETOS) y un SHA256SUMS para comprobarlo con `sha256sum -c`.
 *
 * Nada de aquí importa las salidas (salidas/ no existe en Community): el CEF se
 * escribe aquí, con el mismo mapeo.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { isIP } from 'node:net';
import { nombreAccion } from '$lib/formato';

export const FORMATO_EXPORTACION = 'sugardaddy-export/1';

/* Un trozo de tabla se cierra al pasar de esto (sin comprimir). */
export const TAMANO_TROZO = 8 * 1024 * 1024;

/* --------------------------------------------------------------- tar */

const BLOQUE = 512;

function octal(n: number, ancho: number): string {
	return n.toString(8).padStart(ancho - 1, '0') + '\0';
}

/*
 * La cabecera ustar de un fichero normal. Los nombres que pone la exportación son
 * cortos y ASCII (sección/tabla-0001.jsonl): de 100 bytes no pasan.
 */
export function cabeceraTar(nombre: string, tamano: number, mtime: Date): Buffer {
	const n = Buffer.from(nombre, 'utf8');
	if (n.length > 99) throw new Error(`tar: name too long: ${nombre}`);
	const h = Buffer.alloc(BLOQUE, 0);
	n.copy(h, 0);
	h.write(octal(0o644, 8), 100, 'ascii');
	h.write(octal(0, 8), 108, 'ascii');
	h.write(octal(0, 8), 116, 'ascii');
	h.write(octal(tamano, 12), 124, 'ascii');
	h.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 'ascii');
	h.write('        ', 148, 'ascii');
	h.write('0', 156, 'ascii');
	h.write('ustar\0', 257, 'ascii');
	h.write('00', 263, 'ascii');
	h.write('sugardaddy', 265, 'ascii');
	h.write('sugardaddy', 297, 'ascii');
	let suma = 0;
	for (const b of h) suma += b;
	h.write(octal(suma, 7) + ' ', 148, 'ascii');
	return h;
}

/* Un fichero entero dentro del tar: cabecera, contenido y relleno hasta el bloque. */
export function entradaTar(nombre: string, contenido: Buffer, mtime: Date): Buffer[] {
	const resto = contenido.length % BLOQUE;
	return [
		cabeceraTar(nombre, contenido.length, mtime),
		contenido,
		...(resto ? [Buffer.alloc(BLOQUE - resto, 0)] : [])
	];
}

/* El final de un tar: dos bloques de ceros. */
export const finTar = () => Buffer.alloc(BLOQUE * 2, 0);

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------- sin secretos */

/*
 * Lo que nunca sale en la exportación de los ajustes: cualquier campo cuyo nombre
 * dice que es una clave privada, un secreto, un hash de contraseña o un código, y
 * cualquier valor cifrado con la clave del nodo (secretos.ts: «v1.<id>.<iv>…»).
 * Mejor quitar de más: lo que se exporta es para salir del producto, no para
 * restaurar el nodo (para eso están las copias con age).
 */
const CAMPO_SECRETO =
	/secret|secreto|privad|private|password|contrasena|token|hash|codigo|^pin$|cookie|cifrad|^clave$|clave(?!.*publica)/i;
const VALOR_CIFRADO = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const QUITADO = '[removed]';

export function sinSecretos(v: unknown, profundidad = 0): unknown {
	if (profundidad > 32) return QUITADO;
	if (typeof v === 'string') return VALOR_CIFRADO.test(v) ? QUITADO : v;
	if (Array.isArray(v)) return v.map((x) => sinSecretos(x, profundidad + 1));
	if (v && typeof v === 'object' && !(v instanceof Date)) {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>))
			o[k] = CAMPO_SECRETO.test(k) ? QUITADO : sinSecretos(x, profundidad + 1);
		return o;
	}
	return v;
}

/* ---------------------------------------------------------------- CEF */

const escaparCabeceraCef = (t: string) =>
	t
		.replace(/\\/g, '\\\\')
		.replace(/\|/g, '\\|')
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');

const escaparValorCef = (t: string) =>
	t
		.replace(/\\/g, '\\\\')
		.replace(/=/g, '\\=')
		.replace(/\r\n|\r|\n/g, '\\n')
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');

/* 0-10 en CEF, igual que en las salidas (salidas/canales/formatos.ts). */
const SEVERIDAD_CEF: Record<string, number> = { baja: 3, media: 5, alta: 8, critica: 10 };

/* Una fila de la tabla eventos tal cual sale de la base (nombres de columna). */
export type FilaEventoExport = {
	id: string;
	cuando: string;
	recibido: string;
	trampa: string;
	modulo: string;
	tipo: string;
	accion: string;
	severidad: string;
	ip: string | null;
	usuario: string | null;
	conexion_establecida: boolean;
	alerta: string | null;
	sensor: string;
	linea: string;
};

/*
 * Un evento en CEF, con el mismo mapeo que la salida syslog (docs/siem-cef-leef.md):
 * mismo deviceEventClassId (trampa.<acción>), mismos cs1-cs5 y flexString. El
 * puerto, el equipo y el detalle salen de la línea firmada del sensor.
 */
export function lineaCef(
	f: FilaEventoExport,
	nombres: { trampas: Map<string, string>; sensores: Map<string, string> },
	nodo: { id: string; nombre: string },
	version: string
): string {
	let origen: { puerto?: number; equipo?: string } = {};
	let detalle: unknown = null;
	try {
		const l = JSON.parse(f.linea) as { origen?: typeof origen; detalle?: unknown };
		origen = l.origen ?? {};
		detalle = l.detalle ?? null;
	} catch {
		/* Una línea que no es JSON va sin puerto ni detalle. */
	}
	const trampa = nombres.trampas.get(f.trampa) ?? f.trampa;
	const ip = f.ip && isIP(f.ip) ? f.ip : null;
	const v6 = !!ip && isIP(ip) === 6;
	const ms = (t: string) => {
		const n = Date.parse(t);
		return Number.isNaN(n) ? null : n;
	};
	const detalleTexto =
		detalle && typeof detalle === 'object' && Object.keys(detalle).length
			? JSON.stringify(detalle).slice(0, 4000)
			: null;
	const campos: [string, string | number | null | undefined][] = [
		['rt', ms(f.cuando)],
		['externalId', f.id],
		['act', f.accion],
		['cat', 'trampa'],
		['src', v6 ? null : ip],
		['c6a2Label', v6 ? 'Source IPv6 Address' : null],
		['c6a2', v6 ? ip : null],
		['spt', typeof origen.puerto === 'number' ? origen.puerto : null],
		['suser', f.usuario ? f.usuario.slice(0, 255) : null],
		['shost', typeof origen.equipo === 'string' ? origen.equipo.slice(0, 255) : null],
		['dvchost', nodo.nombre],
		['deviceExternalId', nodo.id],
		['cs1Label', 'Trampa'],
		['cs1', trampa],
		['cs2Label', 'IdTrampa'],
		['cs2', f.trampa],
		['cs3Label', 'Sensor'],
		['cs3', nombres.sensores.get(f.sensor) ?? f.sensor],
		['cs4Label', f.alerta ? 'Alerta' : null],
		['cs4', f.alerta],
		['cs5Label', detalleTexto ? 'Detalle' : null],
		['cs5', detalleTexto],
		['flexString1Label', 'Modulo'],
		['flexString1', f.modulo],
		['flexString2Label', 'TipoTrampa'],
		['flexString2', f.tipo],
		['cn1Label', 'ConexionEstablecida'],
		['cn1', f.conexion_establecida ? 1 : 0],
		['deviceCustomDate1Label', 'Recibido'],
		['deviceCustomDate1', ms(f.recibido)]
	];
	const cabecera = [
		'CEF:0',
		'SeguridadSI',
		'Sugardaddy',
		version.replace(/[^\x21-\x7e]/g, '') || 'dev',
		`trampa.${f.accion}`,
		`${nombreAccion[f.accion] ?? f.accion} on decoy "${trampa}"`,
		String(SEVERIDAD_CEF[f.severidad] ?? 3)
	]
		.map((x, i) => (i === 0 ? x : escaparCabeceraCef(x)))
		.join('|');
	const ext = campos
		.filter(([, v]) => v !== null && v !== undefined && v !== '')
		.map(([k, v]) => `${k}=${escaparValorCef(String(v))}`)
		.join(' ');
	return `${cabecera}|${ext}`;
}

/* -------------------------------------------------------- manifiesto */

export type FicheroManifiesto = {
	ruta: string;
	tabla: string | null;
	formato: 'jsonl' | 'cef' | 'json' | 'text';
	filas: number | null;
	bytes: number;
	sha256: string;
};

export type ClaveFirma =
	| { algoritmo: 'ed25519'; privada: string; publica: string }
	| { algoritmo: 'hmac-sha256'; secreto: string };

/* Lo que se firma: el nodo y el hash del manifiesto, con un prefijo propio (no sirve como sello). */
export const textoFirmaExportacion = (nodo: string, hashManifiesto: string) =>
	`sugardaddy/exportacion\n${nodo}\n${hashManifiesto}`;

const claveHmac = (hex: string) =>
	createHash('sha256').update('sugardaddy/exportacion\n').update(Buffer.from(hex, 'hex')).digest();

export type FirmaExportacion = {
	algoritmo: 'ed25519' | 'hmac-sha256' | 'none';
	nodo: string;
	manifiestoSha256: string;
	texto: string;
	firma: string | null;
	/* La pública del nodo en PEM (SPKI), con la que cualquiera la comprueba. */
	publica: string | null;
	huellaPublica: string | null;
};

export function firmarExportacion(
	clave: ClaveFirma | null,
	nodo: string,
	manifiesto: Buffer
): FirmaExportacion {
	const hash = sha256(manifiesto);
	const texto = textoFirmaExportacion(nodo, hash);
	if (!clave)
		return {
			algoritmo: 'none',
			nodo,
			manifiestoSha256: hash,
			texto,
			firma: null,
			publica: null,
			huellaPublica: null
		};
	if (clave.algoritmo === 'ed25519') {
		const k = createPrivateKey({
			key: Buffer.from(clave.privada, 'base64'),
			format: 'der',
			type: 'pkcs8'
		});
		const der = Buffer.from(clave.publica, 'base64');
		const pem = createPublicKey({ key: der, format: 'der', type: 'spki' })
			.export({ format: 'pem', type: 'spki' })
			.toString();
		return {
			algoritmo: 'ed25519',
			nodo,
			manifiestoSha256: hash,
			texto,
			firma: sign(null, Buffer.from(texto, 'utf8'), k).toString('base64'),
			publica: pem,
			huellaPublica: sha256(der).slice(0, 16)
		};
	}
	return {
		algoritmo: 'hmac-sha256',
		nodo,
		manifiestoSha256: hash,
		texto,
		firma: createHmac('sha256', claveHmac(clave.secreto)).update(texto).digest('base64'),
		publica: null,
		huellaPublica: null
	};
}

/* Las líneas de SHA256SUMS, en el formato de `sha256sum -c`. */
export const sumas = (ficheros: FicheroManifiesto[]) =>
	ficheros.map((f) => `${f.sha256}  ${f.ruta}\n`).join('');

export const LEEME = `Sugardaddy full export (${FORMATO_EXPORTACION})
=========================================

This archive is everything this Sugardaddy console holds about your deployment,
in open formats, so you can keep it, load it into another tool or hand it to an
auditor. Secrets (password hashes, encryption and signing keys, API token
hashes, encrypted output credentials) are never exported.

Layout
------
  manifest.json          what is inside: every file with its row count, size and SHA-256,
                         the audit chain head and the last seal
  manifest.sig.json      the node's signature over manifest.json
  public-key.pem         the node's public key (Ed25519), when it has one
  SHA256SUMS             the same hashes, for "sha256sum -c SHA256SUMS"
  events/                every event, JSON Lines (one row per line) and CEF (same mapping
                         as the syslog output: docs/siem-cef-leef.md)
  incidents/             incidents, triage, artifacts metadata, response executions
  audit/                 the audit log with its hash chain, the seals and the chain head
  configuration/         decoys, sensors, targets, beacons, outputs, rules, lists, templates
  users/                 local users, emergency keys and API tokens (no secrets)
  settings/              node settings (secrets removed)

Large tables are split into parts (events-0001.jsonl, events-0002.jsonl...): read them in order.

Verifying
---------
1. Files:      sha256sum -c SHA256SUMS
2. Signature:  with an Ed25519 node key,
                 jq -j .texto manifest.sig.json > signed.txt
                 jq -r .firma manifest.sig.json | base64 -d > signature.bin
                 openssl pkeyutl -verify -pubin -inkey public-key.pem -rawin \\
                   -in signed.txt -sigfile signature.bin
               and check that "sha256sum manifest.json" equals manifiestoSha256.
               Community nodes sign with an HMAC of their own secret: only that node
               can check it. Central also knows your node's public key.
3. Audit log:  every row of audit/audit-log-*.jsonl has "canonica", the exact text that
               was hashed. For each row, sha256(hash_anterior + canonica) == hash, and the
               next row's hash_anterior is this row's hash. The last hash must match
               audit/head.json and, up to its "hasta" row, the last seal.
4. The console's own audit log records this export with the archive's SHA-256
   ("full data export completed"): compare it with "sha256sum" of this file.
`;
