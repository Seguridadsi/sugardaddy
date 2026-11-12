/*
 * La métrica de ruido de los honeypots: cuánto de lo que llega no pide hacer
 * nada. «No accionable» es lo que alguien marcó como falso positivo y lo que
 * pidió un escáner conocido. Las pruebas de la consola no cuentan: no son
 * ruido ni ataque. Pura; los números salen de server/ruido.ts.
 */
export type RuidoDeTrampa = {
	id: string;
	nombre: string;
	modulo: string;
	/* Eventos recibidos en el periodo, sin las pruebas. */
	eventos: number;
	escaner: number;
	falsosPositivos: number;
	/* Marcados como interesantes: lo que sí pedía hacer algo. */
	confirmados: number;
};

export const noAccionables = (t: Pick<RuidoDeTrampa, 'escaner' | 'falsosPositivos'>) =>
	t.escaner + t.falsosPositivos;

/* Qué parte de lo recibido no pedía hacer nada, de 0 a 1; null sin eventos. */
export function parteDeRuido(t: Pick<RuidoDeTrampa, 'eventos' | 'escaner' | 'falsosPositivos'>) {
	return t.eventos > 0 ? Math.min(1, noAccionables(t) / t.eventos) : null;
}

/*
 * El número con el que se compara un despliegue con otro: eventos no
 * accionables por cada 1.000 honeypots y mes (30 días). null sin honeypots.
 */
export function ruidoPorMil(trampas: readonly RuidoDeTrampa[], dias: number): number | null {
	if (!trampas.length || dias <= 0) return null;
	const total = trampas.reduce((n, t) => n + noAccionables(t), 0);
	return Math.round(((total / trampas.length) * 1000 * 30) / dias);
}

export const porcentaje = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
