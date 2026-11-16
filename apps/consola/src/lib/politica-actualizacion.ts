/*
 * La política de cambios del nodo (docs/diseno/politica-cambios.md, DORA B-16): cuándo se
 * instala una versión firmada que ya ha llegado.
 *
 * - automática: en cuanto llega (lo de siempre);
 * - manual: una persona con el rol de administrador la aprueba en Ajustes;
 * - las dos con un retardo mínimo opcional desde que se publicó (la fecha va firmada). Banca:
 *   manual y 72 h. Una versión firmada como urgente (arreglo de seguridad) se salta el
 *   retardo, nunca la aprobación.
 *
 * La consola solo informa y retiene: quien decide de verdad es el actualizador, que repite la
 * misma cuenta con su suelo local del .env (sensor/internal/actualizador/politica.go). Este
 * fichero es puro: lo usan el servidor y la página.
 */
export const MODOS_POLITICA = ['automatica', 'manual'] as const;
export type ModoPolitica = (typeof MODOS_POLITICA)[number];

export type PoliticaActualizacion = { modo: ModoPolitica; retardoHoras: number };
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
	return { modo, retardoHoras };
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

export const esBanca = (p: PoliticaActualizacion) =>
	p.modo === POLITICA_BANCA.modo && p.retardoHoras >= POLITICA_BANCA.retardoHoras;

/* Lo que se necesita de la versión firmada: su número, cuándo se publicó y si es urgente. */
export type DatosVersion = { version: string; publicada: string; urgente: boolean };

export type Espera =
	{ motivo: null } | { motivo: 'aprobacion' } | { motivo: 'retardo'; hasta: string | null };

/* La misma cuenta que ComprobarPolitica en Go. */
export function esperaDe(
	v: DatosVersion,
	p: PoliticaActualizacion,
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
