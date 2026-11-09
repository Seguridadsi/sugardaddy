/*
 * Freno por clave (una IP o «todas»): cuántas veces caben en una ventana de
 * tiempo. Vive en la memoria del proceso: la consola es uno solo y lo que frena
 * es la fuerza bruta desde fuera, no la cuenta exacta tras un reinicio (un
 * reinicio no se provoca desde la red). Acotado en tamaño para que muchas IP
 * distintas no llenen la memoria: al pasar de MAX_CLAVES se olvidan las
 * ventanas ya cerradas y, si no basta, las más antiguas.
 *
 * Es una ventana fija: al empezar una nueva vuelve a haber cupo entero. Para lo
 * que frena (adivinar un código, probar contraseñas) basta, y no guarda nada
 * por petición.
 */
const MAX_CLAVES = 10_000;

type Ventana = { desde: number; n: number };

export class Freno {
	private ventanas = new Map<string, Ventana>();

	constructor(
		readonly max: number,
		readonly ventanaMs: number
	) {}

	/* true si cabe una más, y la cuenta; false si esa clave ya llegó al tope en esta ventana. */
	pasa(clave: string, ahora = Date.now()): boolean {
		const v = this.ventanas.get(clave);
		if (!v || ahora - v.desde >= this.ventanaMs) {
			if (!v && this.ventanas.size >= MAX_CLAVES) this.podar(ahora);
			this.ventanas.set(clave, { desde: ahora, n: 1 });
			return true;
		}
		if (v.n >= this.max) return false;
		v.n++;
		return true;
	}

	private podar(ahora: number) {
		for (const [k, v] of this.ventanas)
			if (ahora - v.desde >= this.ventanaMs) this.ventanas.delete(k);
		/* Un Map recorre en orden de alta: las primeras son las más antiguas. */
		for (const k of this.ventanas.keys()) {
			if (this.ventanas.size < MAX_CLAVES * 0.9) break;
			this.ventanas.delete(k);
		}
	}

	/* Para las pruebas. */
	olvidar() {
		this.ventanas.clear();
	}
}

/* La clave de una petición: su IP, o «sin-ip» si no se sabe (todas las desconocidas comparten cupo). */
export const claveIp = (ip: string | null | undefined) => (ip ? `ip:${ip}` : 'sin-ip');
