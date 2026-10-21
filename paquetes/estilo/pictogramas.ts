/*
 * El pictograma de cada trampa: un dibujo propio de su tipo de servicio, en
 * los colores de la marca y con el sello de la abeja. Los dibujos están en
 * marca/pictogramas/ y marca/preparar.sh los copia a static/pictogramas/ de la
 * consola y del panel (marca/README.md).
 *
 * El tipo de cada trampa se decide aquí, por el id de su módulo, y no en su
 * manifiesto: un módulo es solo datos del servicio que imita, y cómo se pinta
 * en las pantallas es cosa de la aplicación. Un módulo nuevo que no esté en
 * este mapa no tiene tipo y lleva la abeja, hasta que se le asigne uno (lo
 * avisa pictogramas.spec.ts).
 *
 * Solo se importa desde el servidor. El mapa nombra cada módulo, y alguno
 * (cowrie) dice de qué honeypot sale: no debe viajar en el JavaScript que se
 * sirve sin sesión. A la página le llega solo el tipo.
 */

/* Cada tipo tiene su dibujo en marca/pictogramas/fuente/<tipo>.svg. */
export const TIPOS_DE_SERVICIO = [
	'bases-de-datos',
	'ficheros',
	'escritorio-remoto',
	'terminal',
	'web',
	'correo-electronico',
	'red',
	'directorio',
	'contenedores',
	'impresoras',
	'camaras',
	'iot',
	'industria',
	'sanidad',
	'ia',
	'codigo',
	'retencion'
] as const;

export type TipoDeServicio = (typeof TIPOS_DE_SERVICIO)[number];

const TIPO_DE_TRAMPA: Record<string, TipoDeServicio> = {
	/* Bases de datos */
	mysql: 'bases-de-datos',
	postgresql: 'bases-de-datos',
	mssql: 'bases-de-datos',
	oracle: 'bases-de-datos',
	mongodb: 'bases-de-datos',
	redis: 'bases-de-datos',
	memcached: 'bases-de-datos',
	sap: 'bases-de-datos',
	elasticsearch: 'bases-de-datos',
	/* Carpetas y ficheros */
	smb: 'ficheros',
	ftp: 'ficheros',
	tftp: 'ficheros',
	/* Escritorio remoto */
	rdp: 'escritorio-remoto',
	vnc: 'escritorio-remoto',
	/* Terminal y equipos de red */
	cowrie: 'terminal',
	'telnet-red': 'terminal',
	snmp: 'terminal',
	/* Web y portales */
	'login-web': 'web',
	'portal-vpn': 'web',
	'api-interna': 'web',
	'web-vulnerable': 'web',
	'proxy-http': 'web',
	/* Correo */
	correo: 'correo-electronico',
	/* Servicios de red */
	'dns-ntp': 'red',
	sip: 'red',
	envenenador: 'red',
	darknet: 'red',
	/* Directorio y llaves */
	'controlador-dominio': 'directorio',
	bmc: 'directorio',
	/* Contenedores */
	'api-docker': 'contenedores',
	/* Impresoras, cámaras, IoT e industria */
	impresora: 'impresoras',
	'camara-ip': 'camaras',
	'broker-iot': 'iot',
	adb: 'iot',
	scada: 'industria',
	/* Sanidad */
	pacs: 'sanidad',
	hl7: 'sanidad',
	/* Inteligencia artificial */
	mcp: 'ia',
	'api-ia': 'ia',
	/* Código */
	git: 'codigo',
	svn: 'codigo',
	/* Ficheros cebo con baliza */
	'fichero-word': 'ficheros',
	'fichero-excel': 'ficheros',
	'fichero-pdf': 'ficheros',
	/* El receptor que recoge las balizas de esos ficheros */
	'receptor-balizas': 'ficheros',
	/* Retención: las que hacen perder el tiempo al intruso */
	'retencion-ssh': 'retencion',
	'retencion-web': 'retencion'
};

/* El tipo de servicio de un módulo, o null si no tiene (y lleva la abeja). */
export function tipoDeServicio(modulo: string | null | undefined): TipoDeServicio | null {
	return modulo && Object.hasOwn(TIPO_DE_TRAMPA, modulo) ? TIPO_DE_TRAMPA[modulo] : null;
}

/* Los módulos que tienen tipo, para que las pruebas los comparen con el catálogo. */
export const modulosConTipo = () => Object.keys(TIPO_DE_TRAMPA);
