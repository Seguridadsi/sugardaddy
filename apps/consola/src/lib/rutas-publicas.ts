/*
 * Las rutas que se ven sin sesión (hooks.server.ts). Aparte, para poder
 * probarlas sin levantar la consola.
 */

/*
 * Lo único que se ve sin sesión: la entrada (normal y de emergencia) y las
 * API de los sensores, el actualizador y los firewalls, que se autentican
 * cada una con su token.
 */
export const PUBLICO = [
	'/sign-in',
	'/auth/',
	'/emergency',
	'/api/sensor/',
	/* Lo pide curl desde la máquina de un sensor remoto; lo protege el código de un solo uso. */
	'/instalar-sensor/',
	'/api/actualizador/',
	'/api/salud',
	'/api/edl/',
	/* La raíz (pública) de la CA del nodo: hace falta antes de entrar sin avisos. */
	'/ca-raiz.crt'
];

/*
 * Estas casan solo con la ruta exacta o con algo DENTRO de ella («/api/v1/…»),
 * no por prefijo a secas: «/api/v10» o «/api/mcp-x» no quedan abiertas por
 * parecerse. La API pública y el MCP de control: cada petición lleva su token
 * de API (lib/server/api).
 */
export const PUBLICO_CARPETA: string[] = [];

export const esPublica = (ruta: string) =>
	PUBLICO.some((p) => ruta === p || ruta.startsWith(p)) ||
	PUBLICO_CARPETA.some((p) => ruta === p || ruta.startsWith(p + '/'));
