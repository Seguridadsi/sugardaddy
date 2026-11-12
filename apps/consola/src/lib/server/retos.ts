/*
 * Un almacén de retos de un solo uso, en memoria, con caducidad y con tope.
 * Pedir un reto no exige sesión: sin tope, quien los pida en bucle llena la
 * memoria. Con el almacén lleno se va el más antiguo (un Map guarda el orden de
 * entrada), así que el que se acaba de pedir siempre vale.
 */
import { randomBytes } from 'node:crypto';

export function almacenDeRetos<T extends object>(
	maximo: number,
	vidaMs: number,
	ahora: () => number = Date.now
) {
	const retos = new Map<string, T & { caduca: number }>();
	return {
		guardar(datos: T): string {
			for (const [k, v] of retos) if (v.caduca < ahora()) retos.delete(k);
			while (retos.size >= maximo) retos.delete(retos.keys().next().value as string);
			const id = randomBytes(24).toString('base64url');
			retos.set(id, { ...datos, caduca: ahora() + vidaMs });
			return id;
		},
		/* Un reto vale una sola vez. */
		tomar(id: string | undefined) {
			if (!id) return null;
			const r = retos.get(id);
			retos.delete(id);
			return r && r.caduca > ahora() ? r : null;
		},
		get cuantos() {
			return retos.size;
		}
	};
}
