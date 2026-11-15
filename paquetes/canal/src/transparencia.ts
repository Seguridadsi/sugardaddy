/*
 * El registro de transparencia (docs/diseno/firmas-raiz.md §4): todo lo que se firma con una
 * clave de publicación (versiones, licencias, delegaciones, catálogos de partner) se apunta en
 * un registro solo de añadir, público, para que un mal uso de la clave se vea.
 *
 * Es propio y estático: `transparencia/registro.jsonl` en el repo público, una entrada por
 * línea, y su raíz de Merkle (RFC 6962) firmada dentro de la marca de tiempo (marca.ts). Cada
 * entrada lleva solo la huella de lo firmado, nunca su contenido: una licencia no dice de quién
 * es. El nodo no instala una versión que no esté en él (prueba de inclusión, actualizador).
 * El gemelo en Go está en sensor/internal/actualizador/transparencia.go.
 */
import { createHash } from 'node:crypto';

export const TIPOS_REGISTRO = ['version', 'licencia', 'delegacion', 'catalogo-partner'] as const;
export type TipoRegistro = (typeof TIPOS_REGISTRO)[number];

/*
 * Una entrada. huella: sha256 (hex) del texto firmado (el campo `release`, `licencia`…, el que
 * cubre la firma). clave: la huella de la clave que lo firmó. etiqueta: solo para versiones y
 * catálogos («0.30.0 cloud»); nunca un nombre de cliente.
 */
export type EntradaRegistro = {
	n: number;
	tipo: TipoRegistro;
	huella: string;
	clave: string;
	etiqueta?: string;
	cuando: string;
};

/* La cabeza del registro: cuántas entradas y su raíz. Va firmada dentro de la marca. */
export type CabezaRegistro = { tamano: number; raiz: string };

/* Prueba de que una entrada (su línea exacta) está en el registro de esa cabeza. */
export type PruebaRegistro = { entrada: string; indice: number; tamano: number; ruta: string[] };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
export const MAX_RUTA = 64;

const sha256 = (...partes: Buffer[]) => createHash('sha256').update(Buffer.concat(partes)).digest();
export const hojaDe = (linea: string) => sha256(Buffer.from([0]), Buffer.from(linea, 'utf8'));
const nodo = (a: Buffer, b: Buffer) => sha256(Buffer.from([1]), a, b);
export const huellaTexto = (texto: string) => createHash('sha256').update(texto).digest('hex');

/* La mayor potencia de dos menor que n (n > 1). */
const corte = (n: number) => {
	let k = 1;
	while (k * 2 < n) k *= 2;
	return k;
};

/* MTH de RFC 6962 sobre hojas ya calculadas. Un registro vacío es el sha256 de nada. */
export function raizDe(hojas: readonly Buffer[]): Buffer {
	if (hojas.length === 0) return sha256();
	if (hojas.length === 1) return hojas[0];
	const k = corte(hojas.length);
	return nodo(raizDe(hojas.slice(0, k)), raizDe(hojas.slice(k)));
}

/* La ruta de auditoría de la hoja i (PATH de RFC 6962), de abajo arriba. */
export function rutaDe(hojas: readonly Buffer[], i: number): Buffer[] {
	if (hojas.length <= 1) return [];
	const k = corte(hojas.length);
	return i < k
		? [...rutaDe(hojas.slice(0, k), i), raizDe(hojas.slice(k))]
		: [...rutaDe(hojas.slice(k), i - k), raizDe(hojas.slice(0, k))];
}

/* Comprueba una ruta de auditoría (RFC 9162 §2.1.3.2). */
export function incluida(
	hoja: Buffer,
	indice: number,
	tamano: number,
	ruta: readonly Buffer[],
	raiz: Buffer
) {
	if (
		!Number.isSafeInteger(indice) ||
		!Number.isSafeInteger(tamano) ||
		indice < 0 ||
		indice >= tamano
	)
		return false;
	let fn = indice;
	let sn = tamano - 1;
	let r = hoja;
	for (const p of ruta) {
		if (sn === 0) return false;
		if (fn % 2 === 1 || fn === sn) {
			r = nodo(p, r);
			if (fn % 2 === 0)
				while (fn % 2 === 0 && fn !== 0) {
					fn = Math.floor(fn / 2);
					sn = Math.floor(sn / 2);
				}
		} else r = nodo(r, p);
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}
	return sn === 0 && r.equals(raiz);
}

/* Qué falla en una entrada, o null. La línea tiene que ser exactamente su JSON. */
export function motivoEntrada(linea: string, n?: number): string | null {
	let e: EntradaRegistro;
	try {
		e = JSON.parse(linea) as EntradaRegistro;
	} catch {
		return 'the log entry is not JSON';
	}
	if (!e || typeof e !== 'object') return 'the log entry is not JSON';
	if (!Number.isSafeInteger(e.n) || e.n < 0 || (n !== undefined && e.n !== n))
		return 'the log entry is out of order';
	if (!(TIPOS_REGISTRO as readonly string[]).includes(e.tipo)) return 'unknown log entry type';
	if (typeof e.huella !== 'string' || !HEX64.test(e.huella)) return 'malformed log entry hash';
	if (typeof e.clave !== 'string' || !HEX16.test(e.clave)) return 'malformed log entry key';
	if (e.etiqueta !== undefined && (typeof e.etiqueta !== 'string' || e.etiqueta.length > 80))
		return 'malformed log entry label';
	if (typeof e.cuando !== 'string' || !Number.isFinite(Date.parse(e.cuando)))
		return 'malformed log entry date';
	return null;
}

/* Qué falla en la forma de una cabeza o una prueba, o null. */
export function motivoCabeza(c: CabezaRegistro): string | null {
	if (
		!c ||
		!Number.isSafeInteger(c.tamano) ||
		c.tamano < 0 ||
		typeof c.raiz !== 'string' ||
		!HEX64.test(c.raiz)
	)
		return 'malformed log head';
	return null;
}

export function motivoPrueba(p: PruebaRegistro): string | null {
	if (
		!p ||
		typeof p.entrada !== 'string' ||
		p.entrada.length > 1024 ||
		!Number.isSafeInteger(p.indice) ||
		!Number.isSafeInteger(p.tamano) ||
		!Array.isArray(p.ruta) ||
		p.ruta.length > MAX_RUTA ||
		p.ruta.some((h) => typeof h !== 'string' || !HEX64.test(h))
	)
		return 'malformed inclusion proof';
	return motivoEntrada(p.entrada);
}

/*
 * Que una versión (el texto firmado, el campo `release`) está en el registro de esta cabeza:
 * la entrada de la prueba es de tipo version y de esa huella, y su ruta lleva a la raíz.
 */
export function versionEnRegistro(textoVersion: string, cabeza: CabezaRegistro, p: PruebaRegistro) {
	if (motivoCabeza(cabeza) || motivoPrueba(p) || p.tamano !== cabeza.tamano) return false;
	const e = JSON.parse(p.entrada) as EntradaRegistro;
	if (e.tipo !== 'version' || e.huella !== huellaTexto(textoVersion) || e.n !== p.indice)
		return false;
	return incluida(
		hojaDe(p.entrada),
		p.indice,
		p.tamano,
		p.ruta.map((h) => Buffer.from(h, 'hex')),
		Buffer.from(cabeza.raiz, 'hex')
	);
}

/* Lee un registro entero (las líneas), comprobando el orden y la forma de cada entrada. */
export function leerRegistro(texto: string): { lineas: string[]; cabeza: CabezaRegistro } {
	const lineas = texto.split('\n').filter((l) => l !== '');
	lineas.forEach((l, i) => {
		const m = motivoEntrada(l, i);
		if (m) throw new Error(`entrada ${i}: ${m}`);
	});
	return {
		lineas,
		cabeza: { tamano: lineas.length, raiz: raizDe(lineas.map(hojaDe)).toString('hex') }
	};
}

/* La prueba de la entrada i de un registro. */
export function pruebaDe(lineas: readonly string[], i: number): PruebaRegistro {
	const hojas = lineas.map(hojaDe);
	return {
		entrada: lineas[i],
		indice: i,
		tamano: lineas.length,
		ruta: rutaDe(hojas, i).map((h) => h.toString('hex'))
	};
}
