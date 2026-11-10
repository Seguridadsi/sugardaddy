/*
 * El registro gratuito de Community (docs/diseno/registro-community.md).
 *
 * La licencia de registro es una licencia delegada normal: la firma la clave de
 * registro del panel, y un certificado de SeguridadSI dice qué módulos puede dar
 * esa clave. Así el panel de producción nunca tiene la clave de publicación y,
 * si lo comprometen, solo se puede regalar lo que ya es gratis con un correo.
 *
 * El código de activación que recibe la persona es autónomo: lleva la licencia,
 * el token con que el nodo la renovará y el correo que se confirmó. Un nodo sin
 * salida a internet también puede activarse pegándolo.
 */
import { verificarLicencia, type Licencia, type LicenciaFirmada } from './licencia.ts';
import type { Confianza } from './confianza.ts';
import { MODULOS_REGISTRO } from './planes.ts';

/* El «MSP» de las licencias de registro. No se puede usar para un MSP de verdad. */
export const MSP_REGISTRO = 'registro';

export const CLIENTE_REGISTRO = 'community-registro';
export const NODO_REGISTRO = 'community';
/* La licencia de registro no se ata a un nodo: el campo es obligatorio pero no cuenta. */
export const NODO_CLAVE_REGISTRO = 'AA==';

export const PREFIJO_CODIGO = 'SDR1.';
export const TAM_MAX_CODIGO = 16_384;
export const TAM_TOKEN = 43; /* 32 bytes en base64url */

export type CodigoActivacion = { licencia: LicenciaFirmada; token: string; correo: string };

export function codificarCodigo(c: CodigoActivacion): string {
	return PREFIJO_CODIGO + Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/* El código pegado, o null si no tiene forma de código. No verifica la firma. */
export function decodificarCodigo(texto: string): CodigoActivacion | null {
	const t = texto.replace(/\s+/g, '');
	if (t.length > TAM_MAX_CODIGO || !t.startsWith(PREFIJO_CODIGO)) return null;
	let c: unknown;
	try {
		c = JSON.parse(Buffer.from(t.slice(PREFIJO_CODIGO.length), 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	const x = c as CodigoActivacion;
	if (
		!x ||
		typeof x !== 'object' ||
		typeof x.token !== 'string' ||
		x.token.length !== TAM_TOKEN ||
		typeof x.correo !== 'string' ||
		x.correo.length > 254 ||
		!x.licencia ||
		typeof x.licencia !== 'object'
	)
		return null;
	return { licencia: x.licencia, token: x.token, correo: x.correo };
}

/*
 * Una licencia es de registro si la firma la cadena completa hasta la clave de
 * publicación, viene del «MSP» de registro y no da nada fuera de la lista. Con
 * ahora=0 no mira las fechas: una caducada auténtica sigue siendo de registro,
 * y así la consola dice «ha caducado» y no «no la tienes».
 */
export function licenciaDeRegistro(
	clavePublicaPublicacion: string | Confianza,
	f: unknown,
	ahora: number = Date.now()
): { ok: true; licencia: Licencia } | { ok: false; motivo: string } {
	const v = verificarLicencia(clavePublicaPublicacion, f, ahora);
	if (!v.ok) return v;
	if (v.msp !== MSP_REGISTRO) return { ok: false, motivo: 'not a registration license' };
	const fuera = v.licencia.modulos.find((m) => !MODULOS_REGISTRO.has(m));
	if (fuera) return { ok: false, motivo: `a registration license cannot include "${fuera}"` };
	return { ok: true, licencia: v.licencia };
}
