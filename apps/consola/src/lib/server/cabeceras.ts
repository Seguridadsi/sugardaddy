/*
 * Las cabeceras de seguridad de todas las respuestas de la consola (las pone
 * hooks.server.ts al final de cada petición).
 */

/*
 * Las páginas llevan la CSP de vite.config.ts (kit.csp, con nonce para los
 * scripts); lo que no pinta SvelteKit (JSON, descargas, endpoints) no traía
 * ninguna. A eso, la más cerrada: nada se carga ni se ejecuta y nadie lo
 * enmarca. Quien necesita otra la pone él (el informe mensual).
 */
export const CSP_SIN_PAGINA =
	"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const HSTS = 'max-age=31536000; includeSubDomains';

export function ponerCabeceras(h: Headers) {
	h.set('X-Frame-Options', 'DENY');
	h.set('X-Content-Type-Options', 'nosniff');
	h.set('Referrer-Policy', 'same-origin');
	h.set('X-Robots-Tag', 'noindex, nofollow');
	h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	/*
	 * HSTS siempre, no solo si la petición llega como https: detrás de Caddy la
	 * consola puede verla como http. El navegador solo la tiene en cuenta por https.
	 */
	h.set('Strict-Transport-Security', HSTS);
	if (!h.has('content-security-policy')) h.set('Content-Security-Policy', CSP_SIN_PAGINA);
}
