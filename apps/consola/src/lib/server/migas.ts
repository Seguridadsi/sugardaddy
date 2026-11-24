/*
 * Migas entre trampas (idea 5 de las de aitarpit): una trampa que puede enseñar
 * documentos (un portal, una wiki, un historial) nombra las demás trampas del
 * mismo sensor como si fueran equipos de la empresa, con su servicio, su
 * dirección y su puerto, y con un secreto marcado para entrar
 * (marca-secretos.ts). Quien lo sigue va de una trampa a otra, y el secreto
 * que usa en la segunda dice de cuál salió y a quién se dio: la consola ya lo
 * enlaza.
 *
 * Al sensor le llega en ${sd.migas} con un formato cerrado y sin JSON, que el
 * sensor comprueba antes de pasarlo a la trampa:
 *
 *     modulo,direccion,puerto;modulo,direccion,puerto;…
 *
 * Solo las trampas de contenedor en marcha del mismo sensor, con dirección
 * conocida y un puerto TCP publicado; la propia no. Puro.
 */
import { isIP } from 'node:net';

export const MAX_MIGAS = 12;

export type Miga = { modulo: string; direccion: string; puerto: number };

const MODULO = /^[a-z0-9-]{1,40}$/;

/* Una miga que se puede mandar: lo que el sensor también aceptará. */
export function migaValida(m: Miga): boolean {
	return (
		MODULO.test(m.modulo) &&
		isIP(m.direccion) !== 0 &&
		Number.isInteger(m.puerto) &&
		m.puerto >= 1 &&
		m.puerto <= 65535
	);
}

/* El texto de ${sd.migas} para una trampa: las demás, en orden estable, con tope. */
export function textoMigas(propia: string, todas: (Miga & { id: string })[]): string {
	return todas
		.filter((m) => m.id !== propia && migaValida(m))
		.sort((a, b) => a.id.localeCompare(b.id))
		.slice(0, MAX_MIGAS)
		.map((m) => `${m.modulo},${m.direccion},${m.puerto}`)
		.join(';');
}

/*
 * El primer puerto TCP que publica una trampa, con sus parámetros ya
 * completados: «${puertoSsh}» se resuelve con el valor elegido.
 */
export function puertoPublicado(
	puertos: { expuesto: number | string; protocolo: string }[] | undefined,
	parametros: Record<string, unknown>
): number | null {
	for (const p of puertos ?? []) {
		if (p.protocolo !== 'tcp') continue;
		const hueco =
			typeof p.expuesto === 'string' ? /^\$\{([A-Za-z0-9_]+)\}$/.exec(p.expuesto) : null;
		const v = hueco ? parametros[hueco[1]] : p.expuesto;
		const n =
			typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v) ? Number(v) : NaN;
		if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
	}
	return null;
}
