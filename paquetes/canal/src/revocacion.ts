/*
 * La revocación de una licencia de pago (docs/diseno/licencias-de-pago.md, «Caducidad y
 * revocación»; DORA art. 30.3.f, brecha B-06).
 *
 * Una licencia caducada ya no para las trampas que estaban desplegadas: solo impide
 * desplegar o cambiar trampas de pago. Lo que para de verdad una trampa de pago es una
 * revocación explícita, firmada FUERA del panel con la clave de licencias (igual que las
 * licencias: herramientas/revocar-licencia.ts), que el panel guarda y entrega en el latido.
 * El panel no la puede forjar ni deshacer: el nodo guarda todas las que ha visto y no
 * olvida ninguna.
 *
 * Cada revocación es un documento firmado aparte, de UN cliente: el panel entrega a cada
 * nodo solo las de su cliente, así que ningún nodo ve a quién más se le ha revocado nada.
 *
 * Qué revoca: las licencias de `cliente` emitidas hasta `hasta` (incluida). Con `nodo`,
 * solo las de ese nodo; con `licencia` (sha256 en hex del texto firmado de la licencia),
 * solo esa. Una licencia emitida después de `hasta` no está revocada: así se vuelve a dar
 * de alta a un cliente sin deshacer nada (se le emite una licencia nueva).
 *
 * Gemelo en Go: modulos/comun/licencia/licencia.go (Revocacion, Revoca), que la comprueba
 * dentro de cada trampa de pago al arrancar.
 */
import { createHash } from 'node:crypto';
import {
	aConfianza,
	firmadoPor,
	hayClave,
	motivoFirmas,
	type Confianza,
	type Firma
} from './confianza.ts';
import type { Licencia, LicenciaFirmada } from './licencia.ts';

export type Revocacion = {
	tipo: 'revocacion';
	version: 1;
	/* El cliente cuyas licencias se revocan (clientes.id del panel). */
	cliente: string;
	/* Solo las de este nodo, si se dice. */
	nodo?: string;
	/* Solo esta licencia: sha256 en hex de su texto firmado (huellaLicencia). */
	licencia?: string;
	/* Se revocan las emitidas hasta este momento, incluido (RFC 3339). */
	hasta: string;
	emitida: string;
};

export type RevocacionFirmada = { revocacion: string; firma: string; firmas?: Firma[] };

/* Cuántas guarda y pasa un nodo como mucho: son de un solo cliente, nunca hacen falta más. */
export const MAX_REVOCACIONES = 64;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const fechaValida = (v: unknown) =>
	typeof v === 'string' && RFC3339.test(v) && Number.isFinite(Date.parse(v));

/* La huella de una licencia: sha256 de su texto firmado, en hex. */
export const huellaLicencia = (texto: string) => createHash('sha256').update(texto).digest('hex');

/* Qué falla en una revocación ya parseada, o null si su forma vale. */
export function motivoRevocacion(x: unknown): string | null {
	const r = x as Revocacion;
	if (!r || typeof r !== 'object' || r.tipo !== 'revocacion') return 'not a revocation';
	if (r.version !== 1) return 'unknown revocation version';
	if (typeof r.cliente !== 'string' || !ID.test(r.cliente)) return 'malformed customer';
	if (r.nodo !== undefined && (typeof r.nodo !== 'string' || !ID.test(r.nodo)))
		return 'malformed node';
	if (r.licencia !== undefined && (typeof r.licencia !== 'string' || !HEX64.test(r.licencia)))
		return 'malformed license fingerprint';
	if (!fechaValida(r.hasta)) return 'malformed revocation date';
	if (!fechaValida(r.emitida)) return 'malformed issue date';
	return null;
}

/* Firma (de una clave de licencias o de la de legado) y forma. No caduca: una revocación es para siempre. */
export function verificarRevocacion(
	clave: string | Confianza,
	f: unknown
): { ok: true; revocacion: Revocacion } | { ok: false; motivo: string } {
	const x = f as RevocacionFirmada;
	if (
		!x ||
		typeof x !== 'object' ||
		typeof x.revocacion !== 'string' ||
		typeof x.firma !== 'string' ||
		motivoFirmas(x.firmas)
	)
		return { ok: false, motivo: 'does not have the form of a signed revocation' };
	const confianza = aConfianza(clave);
	if (!hayClave(confianza, 'licencias'))
		return { ok: false, motivo: 'there is no trusted key to check the revocation' };
	if (!firmadoPor(confianza, 'licencias', x.revocacion, x.firma, x.firmas))
		return { ok: false, motivo: 'not signed by SeguridadSI' };
	let r: unknown;
	try {
		r = JSON.parse(x.revocacion);
	} catch {
		return { ok: false, motivo: 'the signed content is not JSON' };
	}
	const m = motivoRevocacion(r);
	if (m) return { ok: false, motivo: m };
	return { ok: true, revocacion: r as Revocacion };
}

/* Si una revocación (ya verificada) alcanza a esta licencia (ya verificada) de texto `texto`. */
export function revoca(r: Revocacion, l: Licencia, texto: string): boolean {
	if (r.cliente !== l.cliente) return false;
	if (r.nodo !== undefined && r.nodo !== l.nodo) return false;
	if (r.licencia !== undefined && r.licencia !== huellaLicencia(texto)) return false;
	return Date.parse(l.emitida) <= Date.parse(r.hasta);
}

/*
 * La primera revocación auténtica de la lista que alcanza a la licencia, o null. Las que no
 * se comprueban se ignoran (quitarlas está en manos de quien tiene la máquina igual).
 */
export function revocacionDe(
	clave: string | Confianza,
	revocaciones: unknown,
	f: LicenciaFirmada,
	l: Licencia
): Revocacion | null {
	if (!Array.isArray(revocaciones)) return null;
	for (const x of revocaciones.slice(0, MAX_REVOCACIONES)) {
		const v = verificarRevocacion(clave, x);
		if (v.ok && revoca(v.revocacion, l, f.licencia)) return v.revocacion;
	}
	return null;
}
