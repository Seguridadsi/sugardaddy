/*
 * La marca de tiempo (docs/diseno/firmas-raiz.md §3, R4 de la revisión del 2026-11-14): un
 * documento firmado con una clave de publicación que dice cuál es la última versión de cada
 * edición y caduca en pocos días. Contra la congelación: el panel elige la versión de cada
 * nodo y, tomado, podría dejar a toda la flota en una vieja y vulnerable. Con la marca, el
 * actualizador ve que hay una más nueva que el panel no le ofrece, o que nadie le da una
 * marca fresca, y lo dice en la consola y en el latido. No pide aprobación a nadie.
 *
 * La reparten el panel (la copia en el estado deseado) y una URL estática que el panel no
 * controla (el repo público). La firma la clave `marcas` (PUBLICACION_MARCAS), que se puede
 * automatizar sin que pueda firmar versiones; durante la transición también la de legado o
 * la de la edición del nodo. El gemelo en Go está en sensor/internal/actualizador/marca.go.
 */
import {
	esClaveVerificable,
	firmaValida,
	huellaDe,
	motivoFirmas,
	type Confianza,
	type Firma
} from './confianza.ts';
import {
	motivoCabeza,
	motivoPrueba,
	type CabezaRegistro,
	type PruebaRegistro
} from './transparencia.ts';

export const EDICIONES = ['cloud', 'community'] as const;
export type Edicion = (typeof EDICIONES)[number];

/* La última versión de una edición: su número y cuándo se publicó. */
/*
 * La última versión de una edición: su número, cuándo se publicó y, con el registro de
 * transparencia (§4), la prueba de que está en él, contra la cabeza de esta misma marca. Así
 * un nodo que solo habla con el panel puede comprobar la última sin salir a internet.
 */
export type UltimaVersion = { version: string; publicada: string; prueba?: PruebaRegistro };

export type Marca = {
	tipo: 'marca';
	version: 1;
	emitida: string;
	caduca: string;
	/* Cuántas horas puede tardar un nodo en recibir la última antes de avisar (anillos, pausas). */
	plazoHoras: number;
	ultimas: Partial<Record<Edicion, UltimaVersion>>;
	/* La cabeza del registro de transparencia (§4), firmada aquí. Sin ella, aún no hay registro. */
	registro?: CabezaRegistro;
};

export type MarcaFirmada = { marca: string; firma: string; firmas?: Firma[] };

/* Una marca no puede durar más que esto: si la firma una máquina, que caduque pronto. */
export const VIGENCIA_MAXIMA_MS = 14 * 86_400_000;
/* Ni venir del futuro más que esto (relojes): se guarda la más nueva y no debe atascarse. */
export const MARGEN_FUTURO_MS = 60 * 60_000;
export const PLAZO_MAXIMO_HORAS = 60 * 24;

const SEMVER = /^\d+\.\d+\.\d+$/;
const fecha = (x: unknown) => (typeof x === 'string' ? Date.parse(x) : NaN);

/* Qué falla en la forma de una marca (sin firmas ni fechas respecto a ahora), o null. */
export function motivoMarca(m: Marca): string | null {
	if (!m || typeof m !== 'object' || m.tipo !== 'marca' || m.version !== 1)
		return 'it is not a timestamp';
	const e = fecha(m.emitida);
	const c = fecha(m.caduca);
	if (!Number.isFinite(e) || !Number.isFinite(c) || c <= e) return 'malformed timestamp dates';
	if (c - e > VIGENCIA_MAXIMA_MS) return 'the timestamp lasts too long';
	if (!Number.isSafeInteger(m.plazoHoras) || m.plazoHoras < 1 || m.plazoHoras > PLAZO_MAXIMO_HORAS)
		return 'malformed timestamp grace period';
	if (m.registro !== undefined && motivoCabeza(m.registro)) return 'malformed log head';
	if (!m.ultimas || typeof m.ultimas !== 'object' || Array.isArray(m.ultimas))
		return 'malformed latest versions';
	for (const [ed, u] of Object.entries(m.ultimas)) {
		if (!(EDICIONES as readonly string[]).includes(ed))
			return `unknown edition (${ed.slice(0, 20)})`;
		if (!u || typeof u.version !== 'string' || !SEMVER.test(u.version))
			return 'malformed latest version';
		if (!Number.isFinite(fecha(u.publicada))) return 'malformed latest version date';
		if (u.prueba !== undefined) {
			const mp = motivoPrueba(u.prueba);
			if (mp) return mp;
			if (!m.registro || u.prueba.tamano !== m.registro.tamano)
				return 'the inclusion proof is not for this log head';
		}
	}
	return null;
}

/*
 * Las claves con las que vale una marca: las de las marcas, la de legado y las de la edición
 * de quien comprueba (sin edición, las de las dos). Ninguna de licencias ni de delegaciones.
 */
export function clavesDeMarca(c: Confianza, marcas: readonly string[], edicion?: Edicion | null) {
	const usos: readonly string[] = edicion ? [edicion] : EDICIONES;
	return [
		...marcas.filter(esClaveVerificable),
		...(c.legado ? [c.legado] : []),
		...c.claves.filter((k) => usos.includes(k.uso)).map((k) => k.publica)
	];
}

export type MarcaVerificada = { marca: Marca; firmadaCon: string; caducada: boolean };

/*
 * Comprueba la firma y la forma. Una marca caducada se devuelve igual (caducada: true): quien
 * la recibe necesita saber que existe para avisar. Una del futuro no vale.
 */
export function verificarMarca(
	c: Confianza,
	marcas: readonly string[],
	f: MarcaFirmada,
	ahora = Date.now(),
	edicion?: Edicion | null
): ({ ok: true } & MarcaVerificada) | { ok: false; motivo: string } {
	if (!f || typeof f.marca !== 'string' || f.marca.length > 64 * 1024 || motivoFirmas(f.firmas))
		return { ok: false, motivo: 'does not have the form of a signed timestamp' };
	let m: Marca;
	try {
		m = JSON.parse(f.marca) as Marca;
	} catch {
		return { ok: false, motivo: 'it is not a timestamp' };
	}
	const candidatas = clavesDeMarca(c, marcas, edicion);
	let firmadaCon: string | null = null;
	if (typeof f.firma === 'string')
		firmadaCon = candidatas.find((p) => firmaValida(p, f.marca, f.firma)) ?? null;
	if (!firmadaCon && Array.isArray(f.firmas))
		for (const x of f.firmas.slice(0, 8)) {
			const p = candidatas.find((k) => huellaDe(k) === x.clave);
			if (p && firmaValida(p, f.marca, x.firma)) {
				firmadaCon = p;
				break;
			}
		}
	if (!firmadaCon) return { ok: false, motivo: 'the timestamp is not signed by SeguridadSI' };
	const motivo = motivoMarca(m);
	if (motivo) return { ok: false, motivo };
	if (Date.parse(m.emitida) > ahora + MARGEN_FUTURO_MS)
		return { ok: false, motivo: 'the timestamp comes from the future' };
	return {
		ok: true,
		marca: m,
		firmadaCon: huellaDe(firmadaCon),
		caducada: Date.parse(m.caduca) <= ahora
	};
}

/* La más nueva de varias (por emitida). Así nadie devuelve a un nodo a una marca anterior. */
export const masNueva = <T extends { marca: Marca }>(xs: readonly (T | null | undefined)[]) =>
	xs
		.filter((x): x is T => !!x)
		.reduce<T | null>(
			(a, b) => (!a || Date.parse(b.marca.emitida) > Date.parse(a.marca.emitida) ? b : a),
			null
		);

/* Una marca nueva con las mismas últimas y fechas nuevas: lo que hace el refresco. */
export function renovarMarca(m: Marca, ahora = Date.now(), dias = 5): Marca {
	if (dias <= 0 || dias * 86_400_000 > VIGENCIA_MAXIMA_MS)
		throw new Error('la marca dura entre unas horas y 14 días');
	return {
		...m,
		emitida: new Date(ahora).toISOString(),
		caduca: new Date(ahora + dias * 86_400_000).toISOString()
	};
}
