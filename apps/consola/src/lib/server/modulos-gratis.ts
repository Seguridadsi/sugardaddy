/*
 * Las trampas GRATIS y de código libre (docs/negocio/modelo.md): no llevan
 * candado de licencia. Todo lo demás del catálogo es de pago y su binario
 * cerrado exige licencia al arrancar; la consola, como defensa en profundidad,
 * no mete en el plan una trampa de pago sin licencia válida (ver plan() en
 * sensor.ts). La lista definitiva la cierra Kino.
 *
 * Vive en su propio fichero, sin dependencias (ni de la base de datos ni de
 * SvelteKit), para que sea una ÚNICA fuente de verdad: la lee la consola
 * (catalogo.ts) y también herramientas/es-de-pago.ts, que publicar-trampa.sh usa
 * para negarse a publicar una trampa de pago sin candado.
 *
 * DECISIÓN PARA KINO: modelo.md da RDP como gratis, pero la nota de glutton del
 * encargo lo da como de pago (comparte binario con mssql/vnc). Aquí se sigue
 * modelo.md (rdp gratis). Si Kino lo quiere de pago, basta quitarlo de esta
 * lista y gatear su protocolo en la base de glutton (protocolosDePago).
 */
export const MODULOS_GRATIS: ReadonlySet<string> = new Set([
	'cowrie',
	'smb',
	'rdp',
	'redis',
	'login-web',
	'dns-ntp',
	'impresora',
	'retencion-ssh',
	'retencion-web'
]);

/* Una trampa de pago: la que no está en la lista gratis. Lleva candado de licencia. */
export const esDePago = (moduloId: string) => !MODULOS_GRATIS.has(moduloId);
