/*
 * La política de cambios del nodo (docs/diseno/politica-cambios.md, DORA B-16): cuándo se
 * instala una versión firmada que ya ha llegado.
 *
 * - automática: en cuanto llega (lo de siempre);
 * - manual: una persona con el rol de administrador la aprueba en Ajustes;
 * - las dos con un retardo mínimo opcional desde que se publicó (la fecha va firmada). Banca:
 *   manual y 72 h. Una versión firmada como urgente (arreglo de seguridad) se salta el
 *   retardo, nunca la aprobación ni la ventana;
 * - y con una ventana horaria opcional, con su zona: los días y las horas en que puede empezar
 *   una instalación (sensor/internal/actualizador/ventana.go, con la misma cuenta).
 *
 * El suelo del .env de la máquina (ACTUALIZACION_POLITICA, ACTUALIZACION_RETARDO_HORAS y
 * ACTUALIZACION_VENTANA) se combina con lo de la consola quedándose con lo más estricto
 * (combinar): la consola puede endurecerlo, nunca bajarlo. La política se exporta como
 * plantilla (plantillaDe) para aplicarla igual en otras consolas o dejarla de suelo al instalar.
 *
 * La consola solo informa y retiene: quien decide de verdad es el actualizador, que repite la
 * misma cuenta con su suelo local del .env (sensor/internal/actualizador/politica.go). Este
 * fichero es puro: lo usan el servidor y la página.
 */
export const MODOS_POLITICA = ['automatica', 'manual'] as const;
export type ModoPolitica = (typeof MODOS_POLITICA)[number];

/* Días ISO (1 lunes … 7 domingo), HH:MM y zona IANA (vacía: UTC). Como Ventana en Go. */
export type VentanaActualizacion = { dias: number[]; desde: string; hasta: string; zona?: string };
export type PoliticaActualizacion = {
	modo: ModoPolitica;
	retardoHoras: number;
	/* Sin ventanas (o vacía): a cualquier hora. Basta con que esté abierta una. */
	ventanas?: VentanaActualizacion[];
};
/* Lo que sale de combinar dos políticas: cada grupo tiene que tener alguna ventana abierta. */
export type PoliticaCombinada = {
	modo: ModoPolitica;
	retardoHoras: number;
	grupos: VentanaActualizacion[][];
};

/* Como MaxVentanas en Go. La consola deja poner una; el .env y las plantillas, hasta ocho. */
export const MAX_VENTANAS = 8;
export type AprobacionActualizacion = { version: string; quien: string; cuando: string };

/* Igual que en Go: más de 30 días no tiene sentido y dejaría el nodo sin arreglos. */
export const RETARDO_MAXIMO_HORAS = 720;

export const POLITICA_POR_DEFECTO: PoliticaActualizacion = { modo: 'automatica', retardoHoras: 0 };
/* Lo que pide la gestión de cambios de un banco. */
export const POLITICA_BANCA: PoliticaActualizacion = { modo: 'manual', retardoHoras: 72 };

export function leerPolitica(v: unknown): PoliticaActualizacion {
	const x = (v ?? {}) as Partial<PoliticaActualizacion>;
	const modo = (MODOS_POLITICA as readonly unknown[]).includes(x.modo)
		? (x.modo as ModoPolitica)
		: POLITICA_POR_DEFECTO.modo;
	const h = Number(x.retardoHoras);
	const retardoHoras = Number.isInteger(h) && h > 0 ? Math.min(h, RETARDO_MAXIMO_HORAS) : 0;
	/* Una ventana guardada que no vale se queda (y no abre nunca): nunca se ensancha sola. */
	const ventanas = Array.isArray(x.ventanas)
		? x.ventanas
				.slice(0, MAX_VENTANAS)
				.map((v) => (motivoVentana(v) ? VENTANA_CERRADA : normalizar(v)))
		: [];
	return { modo, retardoHoras, ...(ventanas.length ? { ventanas } : {}) };
}

/* La que nunca abre: lo que vale una ventana que no se entiende. */
const VENTANA_CERRADA: VentanaActualizacion = { dias: [], desde: '', hasta: '' };

const normalizar = (v: VentanaActualizacion): VentanaActualizacion => ({
	dias: [...v.dias],
	desde: v.desde,
	hasta: v.hasta,
	...(v.zona ? { zona: v.zona } : {})
});

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/* Si la zona existe para Intl (las de la base IANA). */
export function zonaValida(z: string | undefined): boolean {
	if (!z || z === 'UTC') return true;
	if (z.length > 64 || z.includes('..') || z.startsWith('/')) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: z });
		return true;
	} catch {
		return false;
	}
}

/* Qué falla en una ventana (null si vale). Como ValidarVentana en Go. */
export function motivoVentana(v: unknown): string | null {
	const x = v as Partial<VentanaActualizacion> | null;
	if (!x || !Array.isArray(x.dias) || x.dias.length === 0 || x.dias.length > 7)
		return 'Choose at least one day for the update window.';
	if (
		!x.dias.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) ||
		new Set(x.dias).size !== x.dias.length
	)
		return 'The window days must be Monday to Sunday, each once.';
	if (
		typeof x.desde !== 'string' ||
		typeof x.hasta !== 'string' ||
		!HORA.test(x.desde) ||
		!HORA.test(x.hasta)
	)
		return 'The window times must be HH:MM.';
	if (x.zona !== undefined && (typeof x.zona !== 'string' || !zonaValida(x.zona)))
		return 'Unknown time zone for the update window.';
	return null;
}

const formatos = new Map<string, Intl.DateTimeFormat>();
const desfases = new Map<string, number>();

/* El desfase de la zona (ms) en esa hora: se cachea por hora, cambia solo con el horario de verano. */
function desfase(zona: string, t: number): number {
	const clave = `${zona}|${Math.floor(t / 3_600_000)}`;
	const ya = desfases.get(clave);
	if (ya !== undefined) return ya;
	let f = formatos.get(zona);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: zona,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
		formatos.set(zona, f);
	}
	const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
	const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
	const d = local - Math.floor(t / 60_000) * 60_000;
	if (desfases.size > 5000) desfases.clear();
	desfases.set(clave, d);
	return d;
}

/* Día ISO y minuto del día en la zona. */
function enZona(t: number, zona: string): { dia: number; min: number } {
	const l = new Date(t + desfase(zona || 'UTC', t));
	const dia = l.getUTCDay() === 0 ? 7 : l.getUTCDay();
	return { dia, min: l.getUTCHours() * 60 + l.getUTCMinutes() };
}

const minutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/* Como Ventana.Abierta en Go: la que no vale, nunca. */
export function ventanaAbierta(v: VentanaActualizacion, t: number): boolean {
	if (motivoVentana(v)) return false;
	const { dia, min } = enZona(t, v.zona ?? '');
	const ayer = dia === 1 ? 7 : dia - 1;
	const desde = minutos(v.desde);
	const hasta = minutos(v.hasta);
	const hoy = v.dias.includes(dia);
	if (desde < hasta) return hoy && min >= desde && min < hasta;
	return (hoy && min >= desde) || (v.dias.includes(ayer) && min < hasta);
}

const grupoAbierto = (g: VentanaActualizacion[], t: number) => g.some((v) => ventanaAbierta(v, t));

const gruposDe = (p: PoliticaActualizacion | PoliticaCombinada): VentanaActualizacion[][] =>
	'grupos' in p ? p.grupos : p.ventanas?.length ? [p.ventanas.slice(0, MAX_VENTANAS)] : [];

/* Lo más estricto de dos (MasEstricta en Go): manual si una lo es, el retardo mayor y las dos ventanas. */
export function combinar(
	a: PoliticaActualizacion | PoliticaCombinada,
	b: PoliticaActualizacion | PoliticaCombinada
): PoliticaCombinada {
	return {
		modo: a.modo === 'manual' || b.modo === 'manual' ? 'manual' : 'automatica',
		retardoHoras: Math.min(Math.max(a.retardoHoras, b.retardoHoras, 0), RETARDO_MAXIMO_HORAS),
		grupos: [...gruposDe(a), ...gruposDe(b)]
	};
}

/* El primer minuto en que todos los grupos están abiertos, en los próximos 8 días (siguienteApertura). */
export function siguienteApertura(grupos: VentanaActualizacion[][], ahora: number): number | null {
	const m0 = Math.floor(ahora / 60_000) * 60_000;
	for (let i = 0; i <= 8 * 24 * 60; i++) {
		const c = m0 + i * 60_000;
		if (c < ahora) continue;
		if (grupos.every((g) => grupoAbierto(g, c))) return c;
	}
	return null;
}

/* ACTUALIZACION_VENTANA, como LeerVentanas en Go: «1-5 02:00-05:00 Europe/Madrid; 6,7 00:00-00:00». */
export function leerVentanas(texto: string | undefined | null): VentanaActualizacion[] | null {
	const t = (texto ?? '').trim();
	if (!t) return [];
	const r: VentanaActualizacion[] = [];
	for (const parte of t.split(';')) {
		const campos = parte.trim().split(/\s+/).filter(Boolean);
		if (!campos.length) continue;
		if (campos.length < 2 || campos.length > 3 || r.length >= MAX_VENTANAS) return null;
		const dias: number[] = [];
		for (const trozo of campos[0].split(',')) {
			const m = /^(\d)(?:-(\d))?$/.exec(trozo);
			if (!m) return null;
			const i = Number(m[1]);
			const j = m[2] ? Number(m[2]) : i;
			if (i < 1 || j > 7 || i > j) return null;
			for (let d = i; d <= j; d++) if (!dias.includes(d)) dias.push(d);
		}
		const [desde, hasta, ...resto] = campos[1].split('-');
		if (resto.length || hasta === undefined) return null;
		const v: VentanaActualizacion = {
			dias,
			desde,
			hasta,
			...(campos[2] ? { zona: campos[2] } : {})
		};
		if (motivoVentana(v)) return null;
		r.push(v);
	}
	return r;
}

export const textoVentanas = (vs: readonly VentanaActualizacion[]) =>
	vs
		.map((v) => `${v.dias.join(',')} ${v.desde}-${v.hasta}${v.zona ? ` ${v.zona}` : ''}`)
		.join('; ');

/*
 * El suelo del .env de la máquina, como PoliticaDelEntorno en Go: lo que no se entiende cuenta
 * como lo más estricto (manual, 720 h, una ventana que no abre).
 */
export function politicaDelEntorno(
	get: (k: string) => string | undefined
): PoliticaActualizacion & {
	ventanaIlegible: boolean;
} {
	const m = (get('ACTUALIZACION_POLITICA') ?? '').trim().toLowerCase();
	const modo: ModoPolitica = m === '' || m === 'automatica' ? 'automatica' : 'manual';
	let retardoHoras = 0;
	const h = (get('ACTUALIZACION_RETARDO_HORAS') ?? '').trim();
	if (h) {
		const n = /^-?\d+$/.test(h) ? Number(h) : NaN;
		retardoHoras =
			!Number.isFinite(n) || n > RETARDO_MAXIMO_HORAS ? RETARDO_MAXIMO_HORAS : Math.max(n, 0);
	}
	const vs = leerVentanas(get('ACTUALIZACION_VENTANA'));
	const ventanas = vs ?? [VENTANA_CERRADA];
	return {
		modo,
		retardoHoras,
		...(ventanas.length ? { ventanas } : {}),
		ventanaIlegible: vs === null
	};
}

/* ¿Pide algo el suelo? */
export const sueloActivo = (p: PoliticaActualizacion) =>
	p.modo === 'manual' || p.retardoHoras > 0 || !!p.ventanas?.length;

/* La plantilla: lo mismo en otra consola (importar), en el .env o al instalar. */
export const FORMATO_PLANTILLA = 'sugardaddy-update-policy@1';

export function plantillaDe(p: PoliticaActualizacion) {
	return {
		formato: FORMATO_PLANTILLA,
		modo: p.modo,
		retardoHoras: p.retardoHoras,
		ventanas: (p.ventanas ?? []).map(normalizar)
	};
}

/* Una plantilla importada; null si no lo es o algo no vale (no se importa a medias). */
export function leerPlantilla(v: unknown): PoliticaActualizacion | null {
	const x = v as Record<string, unknown> | null;
	if (!x || typeof x !== 'object' || x.formato !== FORMATO_PLANTILLA) return null;
	const p = politicaDelFormulario(x.modo, String(x.retardoHoras ?? ''));
	if (!p) return null;
	const vs = x.ventanas ?? [];
	if (!Array.isArray(vs) || vs.length > MAX_VENTANAS || vs.some((w) => motivoVentana(w)))
		return null;
	return {
		...p,
		...(vs.length ? { ventanas: (vs as VentanaActualizacion[]).map(normalizar) } : {})
	};
}

/* Las líneas del .env que dejan esta política de suelo (también valen como variables del instalador). */
export function lineasEnv(p: PoliticaActualizacion): string[] {
	return [
		`ACTUALIZACION_POLITICA=${p.modo}`,
		`ACTUALIZACION_RETARDO_HORAS=${p.retardoHoras}`,
		...(p.ventanas?.length ? [`ACTUALIZACION_VENTANA="${textoVentanas(p.ventanas)}"`] : [])
	];
}

/* Lo que llega del formulario; null si no vale. */
export function politicaDelFormulario(modo: unknown, horas: unknown): PoliticaActualizacion | null {
	if (!(MODOS_POLITICA as readonly unknown[]).includes(modo)) return null;
	const texto = String(horas ?? '').trim() || '0';
	if (!/^\d{1,4}$/.test(texto)) return null;
	const h = Number(texto);
	if (h > RETARDO_MAXIMO_HORAS) return null;
	return { modo: modo as ModoPolitica, retardoHoras: h };
}

export const esBanca = (p: Pick<PoliticaActualizacion, 'modo' | 'retardoHoras'>) =>
	p.modo === POLITICA_BANCA.modo && p.retardoHoras >= POLITICA_BANCA.retardoHoras;

/* Lo que se necesita de la versión firmada: su número, cuándo se publicó y si es urgente. */
export type DatosVersion = { version: string; publicada: string; urgente: boolean };

export type Espera =
	| { motivo: null }
	| { motivo: 'aprobacion' }
	| { motivo: 'retardo'; hasta: string | null }
	| { motivo: 'ventana'; hasta: string | null };

/* La misma cuenta que ComprobarPolitica en Go. */
export function esperaDe(
	v: DatosVersion,
	p: PoliticaActualizacion | PoliticaCombinada,
	a: AprobacionActualizacion | null,
	ahora: number
): Espera {
	if (p.modo === 'manual' && (!a || a.version !== v.version || !a.quien.trim()))
		return { motivo: 'aprobacion' };
	if (p.retardoHoras > 0 && !v.urgente) {
		const pub = Date.parse(v.publicada);
		if (!Number.isFinite(pub)) return { motivo: 'retardo', hasta: null };
		const hasta = pub + p.retardoHoras * 3_600_000;
		if (ahora < hasta) return { motivo: 'retardo', hasta: new Date(hasta).toISOString() };
	}
	/* La ventana, también para una urgente (como en Go). */
	const g = gruposDe(p);
	if (g.length && !g.every((x) => grupoAbierto(x, ahora))) {
		const abre = siguienteApertura(g, ahora);
		return { motivo: 'ventana', hasta: abre === null ? null : new Date(abre).toISOString() };
	}
	return { motivo: null };
}

/* Del texto firmado tal cual (ya verificado al llegar): sin él, nada que contar. */
export function datosDeRelease(texto: string | undefined | null): DatosVersion | null {
	if (!texto) return null;
	try {
		const r = JSON.parse(texto) as { version?: unknown; publicada?: unknown; urgente?: unknown };
		if (typeof r.version !== 'string') return null;
		return {
			version: r.version,
			publicada: typeof r.publicada === 'string' ? r.publicada : '',
			urgente: r.urgente === true
		};
	} catch {
		return null;
	}
}

/* La ventana del formulario de Ajustes (una como mucho); el texto del error si no vale. */
export function ventanaDelFormulario(
	activa: boolean,
	dias: unknown[],
	desde: unknown,
	hasta: unknown,
	zona: unknown
): { ventanas: VentanaActualizacion[] } | { error: string } {
	if (!activa) return { ventanas: [] };
	const z = String(zona ?? '').trim();
	const v: VentanaActualizacion = {
		dias: [...new Set(dias.map((d) => Number(d)))].sort((a, b) => a - b),
		desde: String(desde ?? '').slice(0, 5),
		hasta: String(hasta ?? '').slice(0, 5),
		...(z && z !== 'UTC' ? { zona: z } : {})
	};
	const m = motivoVentana(v);
	return m ? { error: m } : { ventanas: [v] };
}

const NOMBRES_DIAS = [
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
	'Sunday'
] as const;
export const nombreDia = (d: number) => NOMBRES_DIAS[d - 1] ?? String(d);

/* «Monday to Friday, 02:00–05:00 (Europe/Madrid)», para la pantalla. */
export function describirVentana(v: VentanaActualizacion): string {
	if (motivoVentana(v)) return 'an update window that cannot be read (it never opens)';
	const ds = [...v.dias].sort((a, b) => a - b);
	const seguidos = ds.length > 2 && ds.every((d, i) => i === 0 || d === ds[i - 1] + 1);
	const dias =
		ds.length === 7
			? 'every day'
			: seguidos
				? `${nombreDia(ds[0])} to ${nombreDia(ds[ds.length - 1])}`
				: ds.map(nombreDia).join(', ');
	return `${dias}, ${v.desde}–${v.hasta} (${v.zona || 'UTC'})`;
}

/* La zona de quien abre la página, para proponerla en una ventana nueva. */
export function zonaDelNavegador(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}
