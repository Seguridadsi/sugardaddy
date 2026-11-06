/*
 * Las rutas de antes de pasar la interfaz a inglés. Siguen vivas porque hay
 * correos y avisos ya enviados, marcadores y líneas de instalación que las usan.
 * `*` es un tramo cualquiera. Lo más concreto va primero.
 */
const TABLA: [string, string][] = [
	['/avisos/informe-correo', '/reports/email'],
	['/avisos/nueva', '/alerts/new'],
	['/avisos/sentinel/preparar.sh', '/alerts/sentinel/prepare.sh'],
	['/avisos/*', '/alerts/$1'],
	['/avisos', '/alerts'],
	['/aviso/*', '/alert/$1'],
	['/informes', '/reports'],
	['/informe', '/reports/monthly'],
	['/ajustes', '/settings'],
	['/contrasenas', '/passwords'],
	['/destinos/nuevo', '/targets/new'],
	['/destinos/*', '/targets/$1'],
	['/destinos', '/targets'],
	['/emergencia/alta/opciones', '/emergency/enroll/options'],
	['/emergencia/alta/verificar', '/emergency/enroll/verify'],
	['/emergencia/alta', '/emergency/enroll'],
	['/emergencia/opciones', '/emergency/options'],
	['/emergencia/verificar', '/emergency/verify'],
	['/emergencia', '/emergency'],
	['/entrar/cambiar', '/sign-in/change'],
	['/entrar/recuperar', '/sign-in/recover'],
	['/entrar', '/sign-in'],
	['/eventos/reglas', '/events/rules'],
	['/eventos/usuario', '/events/user'],
	['/eventos/csv', '/events/csv'],
	['/eventos/ip/*', '/events/ip/$1'],
	['/eventos/*/sesion', '/events/$1/session'],
	['/eventos/*/artefacto/*', '/events/$1/artifact/$2'],
	['/eventos', '/events'],
	['/incidentes/*', '/incidents/$1'],
	['/incidentes', '/incidents'],
	['/listas', '/lists'],
	['/mapa', '/map'],
	['/mi-cuenta', '/account'],
	['/origenes/pentest/*', '/sources/pentest/$1'],
	['/origenes', '/sources'],
	['/respuestas/historial', '/responses/history'],
	['/respuestas/reglas/nueva', '/responses/rules/new'],
	['/respuestas/reglas/probar', '/responses/rules/test'],
	['/respuestas/reglas/*', '/responses/rules/$1'],
	['/respuestas/*/preparar.sh', '/responses/$1/prepare.sh'],
	['/respuestas/*', '/responses/$1'],
	['/respuestas', '/responses'],
	['/sensores', '/sensors'],
	['/trampas/catalogo/*', '/decoys/catalog/$1'],
	['/trampas/nueva/*', '/decoys/new/$1'],
	['/trampas/*/baliza', '/decoys/$1/beacon'],
	['/trampas/*/pasos/*', '/decoys/$1/steps/$2'],
	['/trampas/*', '/decoys/$1'],
	['/trampas', '/decoys'],
	['/usuarios', '/users']
];

const PATRONES = TABLA.map(
	([vieja, nueva]) =>
		[new RegExp(`^${vieja.replace(/\./g, '\\.').replace(/\*/g, '([^/]+)')}/?$`), nueva] as const
);

/* La ruta de ahora para una de antes; null si la que llega no es de antes. */
export function rutaNueva(ruta: string): string | null {
	for (const [patron, nueva] of PATRONES) if (patron.test(ruta)) return ruta.replace(patron, nueva);
	return null;
}
