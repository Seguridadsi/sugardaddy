import { createHash } from 'node:crypto';

/*
 * Cadena de eventos. Cada evento lleva en hashAnterior el sha256 de los bytes
 * exactos del evento anterior del mismo sensor. Se hashean bytes, no un JSON
 * "canónico": así Go y TypeScript no tienen que ponerse de acuerdo en cómo
 * ordenar claves o escapar caracteres, y el nodo guarda la línea tal cual llegó.
 */

export const GENESIS = '0'.repeat(64);

export function hashEvento(linea: string | Uint8Array): string {
	return createHash('sha256').update(linea).digest('hex');
}

/*
 * Recorre las líneas de un sensor en orden y dice dónde se rompe la cadena:
 * el primer evento cuyo hashAnterior no es el hash de la línea de antes.
 */
export function verificarCadena(lineas: string[]): { ok: true } | { ok: false; rotaEn: number } {
	let anterior = GENESIS;
	for (const [i, linea] of lineas.entries()) {
		let dicho: unknown;
		try {
			dicho = (JSON.parse(linea) as { hashAnterior?: unknown }).hashAnterior;
		} catch {
			return { ok: false, rotaEn: i };
		}
		if (dicho !== anterior) return { ok: false, rotaEn: i };
		anterior = hashEvento(linea);
	}
	return { ok: true };
}
