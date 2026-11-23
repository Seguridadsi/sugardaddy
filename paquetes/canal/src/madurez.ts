/*
 * La madurez de cada trampa, firmada con la versión (D11 de docs/pendientes.md). La calcula
 * herramientas/inventario.ts (orden «madurez») sobre el commit que se publica, con las mismas
 * reglas que las columnas de docs/inventario/inventario.md, y viaja en `Release.madurez`. La
 * consola y el panel la enseñan tal cual: no la deducen ni la inventan.
 *
 * De las cuatro columnas del inventario, dos viajan y dos se deducen al leerla:
 *
 * - hecha y probada vienen firmadas (probada, con la fecha de la prueba que vale y su banco);
 * - publicada: el módulo va en la madurez de la versión firmada en la que está el nodo;
 * - soportada: hecha, probada y publicada, y el manifiesto que tiene el nodo es el de esa
 *   versión (misma versión de módulo). Igual que en el inventario, es un cálculo: no es un
 *   acuerdo de soporte con nadie.
 */

export type MadurezFirmada = {
	/* La versión del módulo (versionModulo) que iba en la versión. */
	version: string;
	/* Columna Hecha del inventario. */
	hecha: boolean;
	/* El día (AAAA-MM-DD) del último BIEN que vale para lo publicado; null = no probada. */
	probada: string | null;
	/* El banco que la prueba; null = no tiene: solo se comprueba en un sistema real. */
	banco: string | null;
};

export type Madurez = Record<string, MadurezFirmada>;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const BANCO = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MODULOS = 2000;

/*
 * La madurez de una versión, comprobada en su forma. Va firmada, pero una forma rara no se
 * enseña a medias: o vale entera o no hay (null), y la pantalla dice que no se sabe.
 */
export function leerMadurez(x: unknown): Madurez | null {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
	const entradas = Object.entries(x as Record<string, unknown>);
	if (entradas.length > MAX_MODULOS) return null;
	const salida: Madurez = {};
	for (const [id, v] of entradas) {
		if (!ID.test(id) || !v || typeof v !== 'object') return null;
		const m = v as Record<string, unknown>;
		if (
			typeof m.version !== 'string' ||
			m.version.length === 0 ||
			m.version.length > 40 ||
			typeof m.hecha !== 'boolean' ||
			!(m.probada === null || (typeof m.probada === 'string' && DIA.test(m.probada))) ||
			!(m.banco === null || (typeof m.banco === 'string' && BANCO.test(m.banco)))
		)
			return null;
		salida[id] = { version: m.version, hecha: m.hecha, probada: m.probada, banco: m.banco };
	}
	return salida;
}

/*
 * El escalón más alto que alcanza, para la etiqueta corta del catálogo:
 * soportada > probada > publicada (sin probar) > sin-publicar (no va en la versión del nodo).
 */
export type NivelMadurez = 'soportada' | 'probada' | 'publicada' | 'sin-publicar';

export type EstadoMadurez = {
	nivel: NivelMadurez;
	hecha: boolean;
	probada: boolean;
	publicada: boolean;
	soportada: boolean;
	/* La versión de Sugardaddy en la que viaja esta madurez. */
	versionNodo: string;
	/* La versión del módulo publicada; null si no va en ella. */
	versionModulo: string | null;
	probadaEl: string | null;
	banco: string | null;
};

/*
 * El estado de un módulo con la madurez de la versión `versionNodo`. `versionLocal` es la
 * versión del manifiesto que tiene esta consola o este panel: si no es la firmada, lo que se
 * ve no es lo que se probó, y no sale soportada.
 */
export function estadoMadurez(
	madurez: Madurez,
	versionNodo: string,
	id: string,
	versionLocal: string
): EstadoMadurez {
	const m = Object.hasOwn(madurez, id) ? madurez[id] : undefined;
	if (!m)
		return {
			nivel: 'sin-publicar',
			hecha: false,
			probada: false,
			publicada: false,
			soportada: false,
			versionNodo,
			versionModulo: null,
			probadaEl: null,
			banco: null
		};
	const probada = m.probada !== null;
	const soportada = m.hecha && probada && m.version === versionLocal;
	return {
		nivel: soportada ? 'soportada' : probada ? 'probada' : 'publicada',
		hecha: m.hecha,
		probada,
		publicada: true,
		soportada,
		versionNodo,
		versionModulo: m.version,
		probadaEl: m.probada,
		banco: m.banco
	};
}

/* Lo que ve el usuario (en inglés, docs/glosario-ingles.md). */
export const NOMBRE_NIVEL_MADUREZ: Record<NivelMadurez, string> = {
	soportada: 'Supported',
	probada: 'Tested',
	publicada: 'Not bench-tested',
	'sin-publicar': 'Not released'
};

export const EXPLICACION_NIVEL_MADUREZ: Record<NivelMadurez, string> = {
	soportada: 'What you run is exactly what passed its test bench.',
	probada: 'It passed its test bench, but the version you run is not the one that was tested.',
	publicada: 'It is released, but it has not passed a test bench for this version yet.',
	'sin-publicar': 'It is not part of the signed release this node runs.'
};
