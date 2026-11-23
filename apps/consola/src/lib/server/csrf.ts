/*
 * La comprobación de origen de SvelteKit para los formularios (CSRF), hecha
 * aquí y no en el propio SvelteKit: es la misma, salvo una ruta. El ACS de SAML
 * (/auth/saml/acs) recibe el POST del proveedor de identidad del cliente, que
 * está en otro dominio, y SvelteKit no deja abrir una excepción por ruta (solo
 * por origen, y el del proveedor lo pone cada cliente). Por eso
 * vite.config.ts lleva `csrf.trustedOrigins: ['*']` y hooks.server.ts llama a
 * esto lo primero. El ACS se defiende solo: no usa cookies y solo acepta una
 * respuesta firmada a una ida de esta consola (saml.ts).
 */
export const SIN_ORIGEN = ['/auth/saml/acs'];

const FORMULARIO = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	/* El de los formularios remotos de SvelteKit (BINARY_FORM_CONTENT_TYPE). */
	'application/x-sveltekit-formdata'
];

/* ¿Se rechaza? Las mismas reglas que kit/src/runtime/server/respond.js. */
export function csrfRechaza(request: Request, url: URL): boolean {
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
	const tipo = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
	if (!FORMULARIO.includes(tipo)) return false;
	if (request.headers.get('origin') === url.origin) return false;
	return !SIN_ORIGEN.includes(url.pathname);
}
