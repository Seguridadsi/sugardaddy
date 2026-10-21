import type { Hechos } from './capacidades.ts';
import type { Requisito, ValorSimple } from './tipos.ts';

/*
 * El comparador de requisitos (docs/diseno/modulo-despliegue.md §3): lenguaje
 * cerrado, cada requisito nombra un hecho y lleva un solo operador. El mismo
 * comparador está en Go (sensor/internal/requisitos) y los dos pasan los mismos
 * vectores (paquetes/contrato/vectores/requisitos.jsonl): si divergen, falla la
 * CI de uno de los dos lados.
 *
 * Puro y sin excepciones: un tipo que no cuadra, o un requisito fuera del
 * lenguaje (sin operador, con dos, presente que no es booleano), da
 * «no-cumple».
 */

export const OPERADORES = ['igual', 'en', 'contiene', 'minimo', 'presente'] as const;
export type Operador = (typeof OPERADORES)[number];

/* sin-dato: el hecho no está (o vale null). «presente» nunca lo da. */
export type ResultadoRequisito = 'cumple' | 'no-cumple' | 'sin-dato';
/* Lo que hace el elector con el resultado (§3.2). */
export type EfectoRequisito = 'nada' | 'avisa' | 'descarta';

const simple = (v: unknown): v is ValorSimple =>
	typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/* Mismo tipo y mismo valor. Una lista u otra cosa no es igual a nada. */
const igual = (a: unknown, b: unknown) => simple(a) && simple(b) && a === b;

/*
 * Las partes numéricas de una versión con puntos, sin ceros a la izquierda:
 * «7.4.6-preview» → [7, 4, 6]. Lo que sigue a la última parte se ignora. Sin
 * una cifra al principio no es una versión.
 */
const VERSION = /^[0-9]+(?:\.[0-9]+)*/;
function partes(v: string): string[] | null {
	const m = VERSION.exec(v);
	return m ? m[0].split('.').map((p) => p.replace(/^0+(?=.)/, '')) : null;
}

/* Dos números en decimal sin ceros a la izquierda, sin convertirlos: sin tope de cifras. */
const compararCifras = (a: string, b: string) =>
	a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;

/* Parte a parte como números; la parte que falta cuenta como 0 (0.13 = 0.13.0). */
function compararVersiones(a: string[], b: string[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const c = compararCifras(a[i] ?? '0', b[i] ?? '0');
		if (c !== 0) return c;
	}
	return 0;
}

/* Número contra número, o versión contra versión; mezclarlos no cumple. */
function alMenos(valor: unknown, minimo: unknown): boolean {
	if (typeof minimo === 'number') return typeof valor === 'number' && valor >= minimo;
	if (typeof minimo !== 'string' || typeof valor !== 'string') return false;
	const a = partes(valor);
	const b = partes(minimo);
	return a !== null && b !== null && compararVersiones(a, b) >= 0;
}

function cumple(op: Operador, valor: unknown, x: unknown): boolean {
	switch (op) {
		case 'igual':
			return igual(valor, x);
		case 'en':
			return Array.isArray(x) && x.some((e) => igual(valor, e));
		case 'contiene':
			return Array.isArray(valor) && valor.some((e) => igual(e, x));
		case 'minimo':
			return alMenos(valor, x);
		case 'presente':
			return false;
	}
}

/* El valor del hecho, o undefined si no está. Un valor null cuenta como que no está. */
function valorDe(hechos: Hechos, clave: unknown): unknown {
	if (typeof clave !== 'string' || !Object.hasOwn(hechos, clave)) return undefined;
	const h: unknown = hechos[clave];
	if (typeof h !== 'object' || h === null || !Object.hasOwn(h, 'valor')) return undefined;
	return (h as { valor: unknown }).valor ?? undefined;
}

export function evaluarRequisito(r: Requisito, hechos: Hechos): ResultadoRequisito {
	const ops = OPERADORES.filter((o) => Object.hasOwn(r, o));
	if (ops.length !== 1) return 'no-cumple';
	const op = ops[0];
	const x: unknown = (r as Record<string, unknown>)[op];
	const valor = valorDe(hechos, r.hecho);
	if (op === 'presente')
		return typeof x === 'boolean' && (valor !== undefined) === x ? 'cumple' : 'no-cumple';
	if (valor === undefined) return 'sin-dato';
	return cumple(op, valor, x) ? 'cumple' : 'no-cumple';
}

/*
 * §3.2. nivel: exige (por defecto) o avisa. siFalta, si no se dice: descarta
 * con exige e ignora con avisa. Un requisito que solo avisa nunca descarta,
 * aunque diga siFalta: descarta (validarHoneycosa lo rechaza).
 */
export function efectoRequisito(
	r: Pick<Requisito, 'nivel' | 'siFalta'>,
	resultado: ResultadoRequisito
): EfectoRequisito {
	const avisa = r.nivel === 'avisa';
	if (resultado === 'cumple') return 'nada';
	if (resultado === 'no-cumple') return avisa ? 'avisa' : 'descarta';
	const siFalta =
		r.siFalta === 'descarta' || r.siFalta === 'avisa' || r.siFalta === 'ignora'
			? r.siFalta
			: avisa
				? 'ignora'
				: 'descarta';
	if (siFalta === 'ignora') return 'nada';
	return siFalta === 'descarta' && !avisa ? 'descarta' : 'avisa';
}
