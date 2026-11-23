/*
 * La web clonada (web-clonada-cebo, H51 y H52; docs/diseno/rele-balizas.md, «Web
 * clonada»): lo común al relé (rele/clon.go), la consola y el banco.
 *
 * El cliente pega la baliza en una página suya, así que cada visita legítima la pide.
 * La URL lleva, tras el token, los sitios del cliente como resúmenes:
 *
 *   /b/<token>/p/<huella>.<huella>…   (hasta MAX_PROPIOS)
 *   huella = base64url(SHA-256("sugardaddy clon v1|" + nombre)[:8])
 *
 * El relé no encola la visita de uno de esos sitios (o de un subdominio suyo), ni la
 * que no trae Referer; la consola lo vuelve a decidir con los dominios en claro
 * (clasificarVisitaClon), porque por el receptor de la red no pasa por ese filtro.
 */
import { createHash } from 'node:crypto';

const INFO = 'sugardaddy clon v1|';
export const MAX_PROPIOS = 8;
const MAX_ETIQUETAS = 10;
/* Un nombre DNS: etiquetas de letras, cifras y guiones, al menos dos. */
const NOMBRE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function huellaSitio(nombre: string): string {
	return createHash('sha256')
		.update(INFO + nombre)
		.digest()
		.subarray(0, 8)
		.toString('base64url');
}

/*
 * Los dominios propios que escribe el cliente, limpios: en minúsculas, sin esquema,
 * ruta, puerto ni punto final, sin repetir y como mucho MAX_PROPIOS. Separados por
 * comas, espacios o saltos. Lo que no es un nombre DNS sale en «malos».
 */
export function dominiosPropios(texto: unknown): { dominios: string[]; malos: string[] } {
	const dominios: string[] = [];
	const malos: string[] = [];
	if (typeof texto !== 'string') return { dominios, malos };
	for (const crudo of texto.split(/[\s,;]+/)) {
		if (!crudo) continue;
		let d = crudo.trim().toLowerCase();
		d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '');
		d = d.replace(/:\d+$/, '').replace(/\.$/, '');
		if (d.startsWith('*.')) d = d.slice(2);
		if (!NOMBRE.test(d)) {
			malos.push(crudo);
			continue;
		}
		if (!dominios.includes(d)) dominios.push(d);
	}
	return { dominios: dominios.slice(0, MAX_PROPIOS), malos };
}

/* El segmento que va tras el token en la URL de la baliza. */
export function segmentoPropios(dominios: readonly string[]): string {
	return '/p/' + dominios.slice(0, MAX_PROPIOS).map(huellaSitio).join('.');
}

/* El nombre del sitio de un Referer, en minúsculas, sin puerto ni punto final; '' si no hay. */
export function sitioDelReferer(referer: unknown): string {
	if (typeof referer !== 'string' || !referer.trim()) return '';
	try {
		const u = new URL(referer.trim());
		if (!u.hostname) return '';
		return u.hostname
			.toLowerCase()
			.replace(/^\[|\]$/g, '')
			.replace(/\.$/, '');
	} catch {
		return '';
	}
}

/* Si un sitio es uno de los dominios o un subdominio suyo. */
function esDe(sitio: string, dominios: readonly string[]): boolean {
	const etiquetas = sitio.split('.').slice(-MAX_ETIQUETAS);
	for (let i = 0; i < etiquetas.length; i++)
		if (dominios.includes(etiquetas.slice(i).join('.'))) return true;
	return false;
}

/*
 * Qué es una visita a una baliza de web clonada: de la web del cliente, sin Referer
 * (los dos son ruido, no un aviso) o de otro sitio, el clon, con su nombre.
 */
export type VisitaClon =
	{ clase: 'propia' } | { clase: 'sin-referer' } | { clase: 'clon'; sitio: string };

export function clasificarVisitaClon(referer: unknown, dominios: readonly string[]): VisitaClon {
	const sitio = sitioDelReferer(referer);
	if (!sitio) return { clase: 'sin-referer' };
	return esDe(sitio, dominios) ? { clase: 'propia' } : { clase: 'clon', sitio };
}

/* Lo mismo que decide el relé, con las huellas del segmento en vez de los nombres. */
export function visitaPropiaPorHuellas(referer: unknown, huellas: ReadonlySet<string>): boolean {
	const sitio = sitioDelReferer(referer);
	if (!sitio) return true;
	const etiquetas = sitio.split('.').slice(-MAX_ETIQUETAS);
	for (let i = 0; i < etiquetas.length; i++)
		if (huellas.has(huellaSitio(etiquetas.slice(i).join('.')))) return true;
	return false;
}
