/*
 * El único sitio donde se le da formato a una fecha que lee una persona: puro,
 * sin base de datos ni petición, vale en el servidor y en el navegador.
 *
 * Las pantallas no lo llaman directamente: usan `fechas-pantalla.ts`, que le pone
 * la zona de quien mira. Un correo o un informe no tiene quien mire y pasa su
 * zona a mano: la de los documentos del nodo (server/zona-documentos.ts).
 */

export const ZONA_POR_DEFECTO = 'Europe/Madrid';

/* La zona que dice el navegador, para que el servidor pinte ya con ella. No es secreta. */
export const COOKIE_ZONA = 'sd_zona_navegador';

const HORA = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;

/*
 * Los formatos de la casa (docs/glosario-ingles.md), con una fecha de ejemplo.
 * `fechaHora` es el de referencia; los demás, lo mismo con más o menos partes.
 */
const ESTILOS = {
	/* 14:05 */
	hora: HORA,
	/* 14:05:09 */
	horaSegundos: { ...HORA, second: '2-digit' },
	/* 6 Nov */
	dia: { day: 'numeric', month: 'short' },
	/* 6 November */
	diaLargo: { day: 'numeric', month: 'long' },
	/* 6 Nov 2026 */
	fecha: { day: 'numeric', month: 'short', year: 'numeric' },
	/* 6 November 2026 */
	fechaLarga: { day: 'numeric', month: 'long', year: 'numeric' },
	/* 6 Nov 2026, 14:05 */
	fechaHora: { day: 'numeric', month: 'short', year: 'numeric', ...HORA },
	/* 6 November 2026 at 14:05 */
	fechaHoraLarga: { dateStyle: 'long', timeStyle: 'short', hourCycle: 'h23' },
	/* 6 November at 14:05 */
	diaHora: { day: 'numeric', month: 'long', ...HORA },
	/* Fri 6 Nov, 14:05 */
	semanaHora: { weekday: 'short', day: 'numeric', month: 'short', ...HORA },
	/* Friday 6 November at 14:05 */
	semanaHoraLarga: { weekday: 'long', day: 'numeric', month: 'long', ...HORA },
	/* November 2026 */
	mes: { month: 'long', year: 'numeric' }
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type EstiloFecha = keyof typeof ESTILOS;

/* Crear un formateador es caro y en una lista se pinta uno por fila. */
const hechos = new Map<string, Intl.DateTimeFormat>();

function formateador(estilo: EstiloFecha, zona: string) {
	const clave = `${estilo}|${zona}`;
	let f = hechos.get(clave);
	if (!f) {
		try {
			f = new Intl.DateTimeFormat('en-GB', { ...ESTILOS[estilo], timeZone: zona });
		} catch {
			/*
			 * El navegador y el servidor traen cada uno su lista de zonas: una que el
			 * servidor da por buena puede no existir aquí, y por una hora no se cae la página.
			 */
			f = new Intl.DateTimeFormat('en-GB', { ...ESTILOS[estilo], timeZone: ZONA_POR_DEFECTO });
		}
		hechos.set(clave, f);
	}
	return f;
}

export function formatearFecha(
	valor: string | number | Date,
	estilo: EstiloFecha,
	zona: string
): string {
	const fecha = new Date(valor);
	return Number.isNaN(fecha.getTime()) ? '' : formateador(estilo, zona).format(fecha);
}

/* Solo nombres de la base de zonas, como Europe/Madrid. Lo demás que traga Intl (+01:00), no. */
const NOMBRE_ZONA = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

export function zonaValida(zona: unknown): zona is string {
	if (typeof zona !== 'string' || !NOMBRE_ZONA.test(zona)) return false;
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone: zona });
		return true;
	} catch {
		return false;
	}
}

/* Lo que ofrece el selector, con UTC delante: Intl no siempre la incluye. */
export function zonasConocidas(): string[] {
	return [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])];
}

/* America/New_York → America/New York */
export const nombreZona = (zona: string) => zona.replaceAll('_', ' ');
