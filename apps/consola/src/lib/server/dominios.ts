/*
 * Dominios para las listas y el feed EDL de dominios. Puro: sin red ni base.
 *
 * - normalizarDominio: valida y normaliza (minúsculas, sin punto final ni
 *   espacios). Devuelve el dominio limpio o null si no es un dominio válido.
 * - cubreDominio: si la lista blanca (dominios) tapa a un dominio, por
 *   coincidencia EXACTA o porque es un subdominio suyo (una blanca
 *   «example.com» protege «example.com» y «mail.example.com», pero una blanca
 *   «mail.example.com» NO protege «example.com»).
 */

/* Etiqueta de dominio: 1-63, alfanumérica, con guiones dentro (no al borde). */
const DOMINIO =
	/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/*
 * Normaliza y valida un dominio. Quita espacios, un punto final (FQDN) y
 * «*.» inicial (comodín que no soportamos como tal: se guarda el dominio base),
 * pasa a minúsculas y exige al menos dos etiquetas y un TLD alfabético. No es
 * una IP (eso se decide antes, por isIP). Devuelve null si no vale.
 */
export function normalizarDominio(valor: string): string | null {
	const d = valor
		.trim()
		.toLowerCase()
		.replace(/^\*\./, '')
		.replace(/\.$/, '');
	if (!d || !DOMINIO.test(d)) return null;
	return d;
}

/* ¿Alguna entrada de la blanca (dominios ya normalizados) tapa a `dominio`? */
export function cubreDominio(blancas: string[], dominio: string): boolean {
	return blancas.some((b) => dominio === b || dominio.endsWith('.' + b));
}
