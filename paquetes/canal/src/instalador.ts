/*
 * El instalador verificado (docs/diseno/instalador-verificado.md, SUP-7).
 *
 * Una versión firmada trae, además de lo de siempre, todo lo que ejecuta como root la
 * máquina del cliente al instalar:
 *
 * - `etapa1`: el guion que el cliente descarga y ejecuta. Es estático (el mismo para todos),
 *   lleva grabadas las claves de publicación y va firmado aparte con la clave de Cloud, para
 *   comprobarlo con openssl antes de ejecutarlo.
 * - `ficheros`: instalar.sh, copia.sh y restaurar.sh de esa versión.
 * - `huellas`: el sha256 de cada pieza que la etapa 1 deja en la máquina, en una sola
 *   cadena `v1;nombre=sha256;…`. La etapa 1 no sabe leer JSON (solo tiene bash y openssl):
 *   comprueba la firma del texto de la versión, saca de él esta cadena y compara con ella lo
 *   que el panel le manda como datos. Así el panel no entrega código: entrega bytes que
 *   tienen que casar con lo firmado.
 *
 * Las piezas que no son ficheros del repositorio (imagenes.env y entorno.txt) se calculan
 * aquí, igual al firmar, al comprobar y al servir.
 */
import { createHash } from 'node:crypto';
import { motivoFirmas, type Firma } from './confianza.ts';
import type { Release } from './index.ts';

export type InstaladorDeVersion = {
	huellas: string;
	ficheros: Record<string, string>;
	etapa1: { texto: string; firmas: Firma[] };
};

/* Los guiones del nodo que viajan en la versión. */
export const FICHEROS_INSTALADOR = ['instalar.sh', 'copia.sh', 'restaurar.sh'] as const;
/* Todo lo que la etapa 1 comprueba contra `huellas`, en este orden. */
export const PIEZAS_INSTALADOR = [
	...FICHEROS_INSTALADOR,
	'compose.yml',
	'Caddyfile',
	'imagenes.env',
	'entorno.txt'
] as const;
export type PiezaInstalador = (typeof PIEZAS_INSTALADOR)[number];

/* Con esto empieza la cadena dentro del texto firmado: la etapa 1 la busca tal cual. */
export const MARCA_HUELLAS = '"huellas":"v1;';
/* Primera línea de la etapa 1: quien la descarga comprueba que es un guion y no otra cosa. */
export const CABECERA_ETAPA1 = '#!/usr/bin/env bash\n# sugardaddy-install 1\n';

const MAX_GUION = 64 * 1024;
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

/*
 * Las piezas de una versión, con su contenido exacto, o null si la versión no trae con qué
 * instalar (sin instalador, sin configuración del nodo o sin alguna de sus tres imágenes).
 */
export function piezasInstalador(r: Release): Record<PiezaInstalador, string> | null {
	const i = r.instalador;
	const nodo = r.nodo;
	if (!i || !nodo || !r.actualizador || !r.servicios?.consola || !r.servicios?.sensor) return null;
	for (const f of FICHEROS_INSTALADOR) if (typeof i.ficheros?.[f] !== 'string') return null;
	if (typeof nodo.ficheros?.['compose.yml'] !== 'string') return null;
	if (typeof nodo.ficheros?.Caddyfile !== 'string') return null;
	return {
		'instalar.sh': i.ficheros['instalar.sh'],
		'copia.sh': i.ficheros['copia.sh'],
		'restaurar.sh': i.ficheros['restaurar.sh'],
		'compose.yml': nodo.ficheros['compose.yml'],
		Caddyfile: nodo.ficheros.Caddyfile,
		/* Lo que instalar.sh copia a versiones.env: la versión y sus imágenes, por digest. */
		'imagenes.env':
			[
				`SUGARDADDY_VERSION=${r.version}`,
				`CONSOLA_IMAGEN=${r.servicios.consola}`,
				`SENSOR_IMAGEN=${r.servicios.sensor}`,
				`ACTUALIZADOR_IMAGEN=${r.actualizador}`
			].join('\n') + '\n',
		/* Las variables nuevas de .env: las fijas, y las que la etapa 1 genera en la máquina. */
		'entorno.txt': [
			...Object.entries(nodo.entorno?.nuevas ?? {}).map(([k, v]) => `nueva ${k}=${v}\n`),
			...(nodo.entorno?.generar ?? []).map((k) => `generar ${k}\n`)
		].join('')
	};
}

/* La cadena `huellas` de unas piezas. */
export const huellasDe = (piezas: Record<PiezaInstalador, string>) =>
	'v1;' + PIEZAS_INSTALADOR.map((n) => `${n}=${sha256(piezas[n])}`).join(';');

/* sha256 de la etapa 1: lo que va fijado en la línea de instalación. */
export const huellaEtapa1 = (texto: string) => sha256(texto);

/*
 * Qué falla en el instalador de una versión, o null. `textoFirmado` es el texto exacto de
 * la versión: la marca de las huellas tiene que salir en él una sola vez, porque la etapa 1
 * la busca sin entender JSON.
 */
export function motivoInstalador(r: Release, textoFirmado: string): string | null {
	const i = r.instalador as InstaladorDeVersion | undefined;
	if (i === undefined) return null;
	if (!i || typeof i !== 'object' || typeof i.huellas !== 'string' || !i.ficheros || !i.etapa1)
		return 'malformed installer';
	const nombres = Object.keys(i.ficheros);
	if (
		nombres.length !== FICHEROS_INSTALADOR.length ||
		FICHEROS_INSTALADOR.some((f) => !nombres.includes(f))
	)
		return 'the installer does not bring exactly its three scripts';
	for (const f of FICHEROS_INSTALADOR) {
		const t = i.ficheros[f];
		if (typeof t !== 'string' || !t.startsWith('#!') || Buffer.byteLength(t) > MAX_GUION)
			return `installer: ${f} is not a script or exceeds 64 KB`;
	}
	const e = i.etapa1;
	if (
		typeof e !== 'object' ||
		typeof e.texto !== 'string' ||
		!e.texto.startsWith(CABECERA_ETAPA1) ||
		Buffer.byteLength(e.texto) > MAX_GUION
	)
		return 'installer: the first stage is not a script or exceeds 64 KB';
	if (!Array.isArray(e.firmas) || motivoFirmas(e.firmas))
		return 'installer: malformed first stage signatures';
	const piezas = piezasInstalador(r);
	if (!piezas) return 'a version with an installer must include the node configuration';
	if (i.huellas !== huellasDe(piezas)) return 'the installer fingerprints do not match its files';
	if (textoFirmado.split(MARCA_HUELLAS).length !== 2)
		return 'the installer fingerprints must appear exactly once in the signed text';
	return null;
}

/* ---------- las claves grabadas en la etapa 1 ---------- */

const LINEA_CLAVES = /^SD_CLAVES='([^'\n]*)'$/m;
const LINEA_LEGADO = /^SD_LEGADO='([^'\n]*)'$/m;
/* Lo que un nodo Cloud necesita: sus versiones, sus licencias y las delegaciones. */
const USOS_CLOUD = ['cloud', 'licencias', 'delegaciones'];

/* Las claves que lleva grabadas una etapa 1, o null si no tiene el bloque. */
export function clavesDeEtapa1(texto: string): { claves: string; legado: string } | null {
	const c = LINEA_CLAVES.exec(texto);
	const l = LINEA_LEGADO.exec(texto);
	return c && l ? { claves: c[1], legado: l[1] } : null;
}

/* De una lista PUBLICACION_CLAVES, las de un nodo Cloud (sin las de Community). */
export const clavesDeCloud = (claves: string) =>
	claves
		.split(',')
		.map((k) => k.trim())
		.filter((k) => USOS_CLOUD.includes(k.split(':')[0]))
		.join(',');

/*
 * La etapa 1 con esas claves grabadas: `claves` en el formato de PUBLICACION_CLAVES (se
 * quedan solo las de Cloud) y la de legado, o vacía si está retirada. El resto del guion no
 * se toca: el mismo texto con las mismas claves da siempre la misma huella.
 */
export function sellarEtapa1(texto: string, claves: string, legado: string): string {
	if (!clavesDeEtapa1(texto)) throw new Error('la etapa 1 no tiene el bloque de claves');
	const deCloud = clavesDeCloud(claves);
	const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
	for (const k of deCloud ? deCloud.split(',') : [])
		if (!B64.test(k.slice(k.indexOf(':') + 1))) throw new Error('clave de publicación mal formada');
	if (legado && !B64.test(legado)) throw new Error('clave de legado mal formada');
	if (!deCloud.split(',').some((k) => k.startsWith('cloud:')) && !legado)
		throw new Error('sin clave de Cloud ni de legado, la etapa 1 no podría comprobar nada');
	return texto
		.replace(LINEA_CLAVES, `SD_CLAVES='${deCloud}'`)
		.replace(LINEA_LEGADO, `SD_LEGADO='${legado}'`);
}

/*
 * Una firma como la quiere `openssl` en un fichero aparte: la de Ed25519, tal cual (64
 * bytes); la de ECDSA P-256, que aquí va en r||s, en DER. null si no es una firma de 64
 * bytes de una de esas dos clases de clave.
 */
export function firmaParaOpenssl(publicaB64: string, firmaB64: string): Buffer | null {
	const f = Buffer.from(firmaB64, 'base64');
	if (f.length !== 64) return null;
	if (publicaB64.startsWith('MCowBQYDK2VwAyEA')) return f;
	if (!publicaB64.startsWith('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE')) return null;
	const entero = (b: Buffer) => {
		let i = 0;
		while (i < b.length - 1 && b[i] === 0) i++;
		let v = b.subarray(i);
		if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
		return Buffer.concat([Buffer.from([2, v.length]), v]);
	};
	const cuerpo = Buffer.concat([entero(f.subarray(0, 32)), entero(f.subarray(32))]);
	return Buffer.concat([Buffer.from([0x30, cuerpo.length]), cuerpo]);
}
