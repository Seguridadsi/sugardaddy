/*
 * Imágenes retiradas (respuesta a incidentes, manual 3: registro de imágenes comprometido;
 * herramientas/retirar-imagen.ts). Una lista firmada de digests (`sha256:…`) que los nodos de
 * una edición no deben arrancar aunque los tengan descargados: ni el actualizador instala una
 * versión que lleve alguno, ni el sensor arranca (ni deja en marcha) una trampa con uno.
 *
 * Va firmada con la clave de publicación de esa edición (`cloud` o `community`, la misma que
 * firma las versiones que fijan esos digests), fuera del panel. La reparte un fichero del repo
 * público (transparencia/retiradas-<edición>.json), que el panel no controla. La lista es
 * acumulativa (la herramienta añade a la anterior) y el nodo además junta todas las que ve: una
 * lista vieja no devuelve a la vida un digest retirado.
 *
 * Gemelo en Go: sensor/internal/actualizador/retiradas.go.
 */
import {
	aConfianza,
	firmadoPor,
	hayClave,
	motivoFirmas,
	type Confianza,
	type Firma
} from './confianza.ts';

export type EdicionRetiradas = 'cloud' | 'community';

export type Retiradas = {
	tipo: 'retiradas';
	version: 1;
	edicion: EdicionRetiradas;
	/* sha256:<64 hex>, sin repetir. */
	digests: string[];
	emitida: string;
};

export type RetiradasFirmadas = { retiradas: string; firma: string; firmas?: Firma[] };

export const MAX_DIGESTS_RETIRADOS = 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/* El digest de una referencia de imagen fijada (…@sha256:…), o null si no lo lleva. */
export function digestDeImagen(imagen: string): string | null {
	const m = /@(sha256:[0-9a-f]{64})$/.exec(imagen.trim());
	return m ? m[1] : null;
}

/* Qué falla en una lista ya leída, o null si su forma vale. */
export function motivoRetiradas(x: unknown): string | null {
	const r = x as Retiradas;
	if (!r || typeof r !== 'object' || r.tipo !== 'retiradas') return 'not a retired image list';
	if (r.version !== 1) return 'unknown retired image list version';
	if (r.edicion !== 'cloud' && r.edicion !== 'community') return 'unknown edition';
	if (!Array.isArray(r.digests) || r.digests.length > MAX_DIGESTS_RETIRADOS)
		return 'malformed retired digests';
	if (!r.digests.every((d) => typeof d === 'string' && DIGEST.test(d)))
		return 'malformed retired digest';
	if (new Set(r.digests).size !== r.digests.length) return 'repeated retired digest';
	if (
		typeof r.emitida !== 'string' ||
		!RFC3339.test(r.emitida) ||
		!Number.isFinite(Date.parse(r.emitida))
	)
		return 'malformed issue date';
	return null;
}

/* El texto que se firma. */
export const textoRetiradas = (r: Retiradas) => JSON.stringify(r);

/* Firma (de la clave de publicación de esa edición, o la de legado), forma y edición. */
export function verificarRetiradas(
	clave: string | Confianza,
	f: unknown,
	edicion: EdicionRetiradas
): { ok: true; retiradas: Retiradas } | { ok: false; motivo: string } {
	const x = f as RetiradasFirmadas;
	if (
		!x ||
		typeof x !== 'object' ||
		typeof x.retiradas !== 'string' ||
		x.retiradas.length > 128 * 1024 ||
		typeof x.firma !== 'string' ||
		motivoFirmas(x.firmas)
	)
		return { ok: false, motivo: 'does not have the form of a signed retired image list' };
	const confianza = aConfianza(clave);
	if (!hayClave(confianza, edicion))
		return { ok: false, motivo: 'there is no trusted key to check the list' };
	if (!firmadoPor(confianza, edicion, x.retiradas, x.firma, x.firmas))
		return { ok: false, motivo: `not signed with a SeguridadSI ${edicion} key` };
	let r: unknown;
	try {
		r = JSON.parse(x.retiradas);
	} catch {
		return { ok: false, motivo: 'the signed content is not JSON' };
	}
	const m = motivoRetiradas(r);
	if (m) return { ok: false, motivo: m };
	if ((r as Retiradas).edicion !== edicion) return { ok: false, motivo: `not for ${edicion}` };
	return { ok: true, retiradas: r as Retiradas };
}
