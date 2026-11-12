/*
 * El sello de unos pasos manuales (BAL-10, docs/diseno/modulo-despliegue.md
 * §6.3): un HMAC de su sha256 con la clave del nodo. El sha256 ya cubre todo lo
 * que se genera, pero no está autenticado: quien tenga escritura en la base de
 * datos puede escribir otros pasos y recomputarlo. El sello no, porque la clave
 * del nodo no sale de su .env. La consola lo pone al guardar los pasos
 * (alta.ts) y lo comprueba al servirlos (pasos.ts, descargarPasos); en el .md y
 * en la cabecera del script sale como «seal», la versión que el administrador
 * compara con lo que revisó. La clave se saca de CLAVE_SECRETOS como en
 * enlaces-aviso.ts, con su propia etiqueta, así que no se reusa para otra cosa.
 *
 * Puro, sin base de datos. Sin clave en el nodo no hay sello (unos pasos de
 * antes tampoco lo tienen): quien descarga se cae al sha256 a secas.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { claveDelNodo } from './secretos';

/* La clave solo para sellar pasos, derivada de la del nodo, y el id de esa clave del nodo. */
function claveSello(): { k: Buffer; id: string } | null {
	const c = claveDelNodo();
	if (!c) return null;
	return {
		k: createHmac('sha256', c.bytes).update('sugardaddy:sello-pasos:v1').digest(),
		id: c.id
	};
}

const macDe = (k: Buffer, id: string, sha256: string) =>
	createHmac('sha256', k).update(`${id}|${sha256}`).digest('base64url');

/*
 * El sello de unos pasos a partir de su sha256, o null si el nodo no tiene
 * clave (CLAVE_SECRETOS): «v1.<id de la clave>.<HMAC>». El id de la clave deja
 * distinguir, al comprobar, «se firmó con otra clave» de «no cuadra».
 */
export function sellarPasos(sha256: string): string | null {
	const c = claveSello();
	return c ? `v1.${c.id}.${macDe(c.k, c.id, sha256)}` : null;
}

export type EstadoSello = 'ok' | 'sin-clave' | 'otra-clave' | 'no-cuadra' | 'mal-formado';

/* Comprueba el sello de unos pasos contra su sha256 y la clave de este nodo. */
export function comprobarSello(sha256: string, sello: string): EstadoSello {
	const partes = sello.split('.');
	if (partes.length !== 3 || partes[0] !== 'v1') return 'mal-formado';
	const c = claveSello();
	if (!c) return 'sin-clave';
	const [, id, mac] = partes;
	if (id !== c.id) return 'otra-clave';
	const esperado = macDe(c.k, c.id, sha256);
	const a = Buffer.from(mac);
	const b = Buffer.from(esperado);
	return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'no-cuadra';
}
