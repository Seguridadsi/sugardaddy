/*
 * Dónde está puesta una trampa, para decidir qué respuesta tiene sentido. No
 * es lo mismo un señuelo DENTRO de la red (si alguien lo toca, el origen es un
 * equipo o una cuenta del propio cliente: contener —bloquear, aislar— tiene
 * sentido) que uno DE CARA A LA WEB (quien lo toca es ruido de internet, el
 * origen no está en la LAN: no se puede bloquear medio internet, solo avisar).
 *
 * El entorno se pone cómodo a nivel de SENSOR (toda su red hereda ese valor) y
 * se puede afinar por HONEYPOT concreto. Gana lo más específico: el de la
 * trampa si lo tiene, si no el de su sensor. Nada puesto = sin entorno, y el
 * motor se comporta como antes (compatibilidad atrás).
 *
 * Puro (sin base de datos ni Svelte): se usa igual en el servidor (la guarda
 * del motor, consultas) y en el navegador (las pantallas de Sensores y de la
 * ficha de la trampa), y se prueba solo.
 */

export const ENTORNOS = ['dentro', 'perimetro-web', 'aislada'] as const;
export type Entorno = (typeof ENTORNOS)[number];

export const esEntorno = (v: unknown): v is Entorno =>
	typeof v === 'string' && (ENTORNOS as readonly string[]).includes(v);

/* El nombre corto para las pantallas. */
export const ENTORNO_ETIQUETA: Record<Entorno, string> = {
	dentro: 'Dentro de la red',
	'perimetro-web': 'De cara a la web',
	aislada: 'Red aislada'
};

/* Una frase que explica qué implica cada entorno para la respuesta. */
export const ENTORNO_EXPLICACION: Record<Entorno, string> = {
	dentro:
		'El origen sería un equipo o una cuenta de tu red: tiene sentido contener (bloquear la IP, aislar el equipo, bloquear la cuenta).',
	'perimetro-web':
		'Quien la toca viene de internet, no de tu red: no se contiene el origen (no se puede bloquear medio internet), solo se avisa y se recoge inteligencia.',
	aislada:
		'Está en una red aislada, sin producción alrededor: se vigila y se avisa; contener el origen no suele aplicar.'
};

/*
 * El entorno efectivo de una trampa: el suyo si lo tiene, si no el de su
 * sensor, si no ninguno. Gana lo más específico (el honeypot sobre el sensor).
 */
export function entornoDe(
	trampa: Entorno | null | undefined,
	sensor: Entorno | null | undefined
): Entorno | null {
	return trampa ?? sensor ?? null;
}

/*
 * ¿Se puede contener el ORIGEN de un evento de una trampa de este entorno? Solo
 * «de cara a la web» lo prohíbe (el origen es ruido de internet, no de la red).
 * Sin entorno puesto se permite: el nodo se comporta como antes de esta función.
 * Las respuestas informativas (avisar, enviar, ticket) no pasan por aquí.
 */
export function contieneElOrigen(entorno: Entorno | null | undefined): boolean {
	return entorno !== 'perimetro-web';
}
