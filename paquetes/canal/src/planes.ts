/*
 * Qué trampas se tienen con cada plan: la ÚNICA fuente de verdad. Cambiar qué
 * entra con el registro es tocar MODULOS_REGISTRO aquí y nada más: de aquí lee la
 * consola (modulos-gratis.ts), la web y el panel (landing.ts, registro.ts), las
 * herramientas (es-de-pago.ts, emitir-certificado-registro.ts) y el generador de
 * Community (construir-community.sh). Sin dependencias, para que lo pueda leer
 * Node sin compilar nada.
 *
 * - Community sin registro: MODULOS_GRATIS, abierta y sin candado.
 * - Community con registro confirmado: además MODULOS_REGISTRO. Son trampas
 *   cerradas con candado real: su binario no arranca sin una licencia firmada
 *   (docs/diseno/registro-community.md).
 * - Cloud: todo el catálogo. Las de registro también van en su licencia.
 */
export const MODULOS_GRATIS: ReadonlySet<string> = new Set(['cowrie']);

export const MODULOS_REGISTRO: ReadonlySet<string> = new Set([
	'smb',
	'rdp',
	'redis',
	'login-web',
	'dns-ntp',
	'impresora',
	'retencion-ssh',
	'retencion-web'
]);

/* Lleva candado de licencia: todo lo que no es gratis, también lo de registro. */
export const esDePago = (moduloId: string) => !MODULOS_GRATIS.has(moduloId);

/* Se activa gratis con el registro en Community. */
export const esDeRegistro = (moduloId: string) => MODULOS_REGISTRO.has(moduloId);
