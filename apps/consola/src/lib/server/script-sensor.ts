/*
 * Lo que entra en el instalador de un sensor remoto (sensores-remotos.ts), que
 * la otra máquina ejecuta con `curl … | sudo bash`: como root.
 *
 * La credencial de descarga la devuelve el panel sin firma (solo la versión de
 * al lado viene firmada con la clave de publicación). Es dato no confiable: un
 * panel comprometido, o un canal interceptado, no puede convertirla en órdenes
 * en las máquinas del cliente (C03 de la auditoría 2026-11-14). Por eso aquí se
 * acota su forma y el script nunca la pone en código de shell: la lee del .env.
 *
 * Lo mismo vale para todo lo que va al .env (un salto de línea añadiría
 * variables) y para los pocos valores que el script sí lleva en su texto: el id
 * del sensor y la dirección de la consola.
 */

/*
 * Un error que se le puede enseñar tal cual a quien instala. El resto sale
 * con un mensaje genérico y queda en el registro de la consola. Su texto nunca
 * lleva lo que se rechaza: va dentro de un script.
 */
export class ErrorCliente extends Error {}

export type Descarga = { registro: string; usuario: string; token: string };

/* Un nombre de host (o una IPv4), con su puerto si lo lleva: lo que acepta `docker login`. */
const ETIQUETA = '[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?';
const HOST = new RegExp(`^${ETIQUETA}(?:\\.${ETIQUETA})*$`);
const REGISTRO = new RegExp(`^${ETIQUETA}(?:\\.${ETIQUETA})*(?::[0-9]{1,5})?$`);
/* El usuario de un token del ACR o de un registro propio. */
const USUARIO = /^[A-Za-z0-9._@-]{1,128}$/;
/* Las contraseñas del ACR son base64: sin comillas, espacios, saltos de línea ni `$`. */
const TOKEN = /^[A-Za-z0-9+/=._~-]{1,1024}$/;

const MAL_PANEL =
	'Central returned a registry credential this console does not accept. Contact your support provider.';

/*
 * La credencial de descarga, comprobada. Sin contraseña (el registro de desarrollo
 * del panel, REGISTRO_DESARROLLO) van vacíos el usuario y el token, los dos.
 */
export function validarDescarga(d: unknown): Descarga {
	if (!d || typeof d !== 'object') throw new ErrorCliente(MAL_PANEL);
	const { registro, usuario, token } = d as Record<string, unknown>;
	if (typeof registro !== 'string' || typeof usuario !== 'string' || typeof token !== 'string')
		throw new ErrorCliente(MAL_PANEL);
	if (registro.length > 253 + 6 || !REGISTRO.test(registro)) throw new ErrorCliente(MAL_PANEL);
	const sinCredencial = usuario === '' && token === '';
	if (!sinCredencial && !(USUARIO.test(usuario) && TOKEN.test(token)))
		throw new ErrorCliente(MAL_PANEL);
	return { registro, usuario, token };
}

const CLAVE_ENV = /^[A-Z_][A-Z0-9_]*$/;
/* Un valor del .env: una línea, sin caracteres de control. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/*
 * El .env del sensor, comprobado línea a línea: cada una es un comentario o
 * CLAVE=valor, sin saltos de línea ni otros caracteres de control dentro. Lo que
 * no encaja para la instalación entera, sin script.
 */
export function entornoDelSensor(lineas: string[]): string {
	for (const l of lineas) {
		if (CONTROL.test(l))
			throw new ErrorCliente(
				'A setting for the sensor contains a line break or a control character. Contact your support provider.'
			);
		if (l.startsWith('#')) continue;
		const igual = l.indexOf('=');
		if (igual < 1 || !CLAVE_ENV.test(l.slice(0, igual)))
			throw new ErrorCliente(
				'A setting for the sensor has an invalid name. Contact your support provider.'
			);
	}
	return lineas.join('\n');
}

/* El id de un sensor, tal como lo guarda la consola (identificador.ts): va en el texto del script. */
const ID_SENSOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function comprobarIdSensor(id: string) {
	if (!ID_SENSOR.test(id))
		throw new ErrorCliente(
			'This sensor identifier cannot be used in an installer. Enroll the sensor again with letters, numbers and hyphens.'
		);
}

/*
 * La dirección de la consola (ORIGIN o CONSOLA_URL) y su nombre, que el script
 * lleva en su texto (curl, getent, el proxy). `new URL` deja pasar en el nombre
 * `'`, `$`, `;` o `` ` ``: aquí solo un nombre de host, una IP o una IPv6 entre
 * corchetes, y una ruta sin nada que el shell interprete.
 */
const URL_SEGURA = /^https:\/\/[A-Za-z0-9._[\]:-]+(?:\/[A-Za-z0-9._~/-]*)?$/;
const IPV6 = /^\[[0-9a-fA-F:.]+\]$/;

export function comprobarConsola(url: string, dominio: string) {
	if (!URL_SEGURA.test(url) || !(HOST.test(dominio) || IPV6.test(dominio)))
		throw new ErrorCliente(
			"This console's address (ORIGIN or CONSOLA_URL in the node configuration) contains characters that cannot be used in an installer."
		);
}

/* Un texto como una sola palabra de shell, sin nada que bash expanda; una sola línea. */
export const comillasSimples = (t: string) =>
	`'${t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/'/g, `'\\''`)}'`;
