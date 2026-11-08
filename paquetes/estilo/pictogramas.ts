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
	'retencion',
	'nube'
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
	/* Volcado de MySQL sembrado (H26): no corre servicio, apunta a una trampa MySQL */
	'volcado-mysql': 'bases-de-datos',
	/* Conexiones de BD guardadas cebo (H117/H118): apuntan a una trampa PostgreSQL/SQL Server */
	'credencial-postgres-cebo': 'bases-de-datos',
	'credencial-mssql-cebo': 'bases-de-datos',
	/* Conexiones Oracle/MongoDB guardadas cebo (H120/H121): apuntan a esas trampas */
	'credencial-oracle-cebo': 'bases-de-datos',
	'credencial-mongodb-cebo': 'bases-de-datos',
	/* Disparador en SQL Server (H42): vista-cebo que conecta a la trampa MSSQL al consultarla */
	'disparador-mssql-cebo': 'bases-de-datos',
	/* Carpetas y ficheros */
	smb: 'ficheros',
	nas: 'ficheros',
	'almacen-s3': 'ficheros',
	ftp: 'ficheros',
	/* Conexión FTP guardada cebo (H116): apunta a una trampa FTP */
	'credencial-ftp-cebo': 'ficheros',
	/* Conexión SMB guardada cebo (H119): apunta a una trampa SMB */
	'credencial-smb-cebo': 'ficheros',
	tftp: 'ficheros',
	webdav: 'ficheros',
	/* Escritorio remoto */
	rdp: 'escritorio-remoto',
	vnc: 'escritorio-remoto',
	/* Conexión RDP guardada cebo (H115): apunta a una trampa RDP */
	'credencial-rdp-cebo': 'escritorio-remoto',
	/* Terminal y equipos de red */
	cowrie: 'terminal',
	'telnet-red': 'terminal',
	'router-upnp': 'terminal',
	snmp: 'terminal',
	/* Credencial SSH sembrada (H21): no corre servicio, apunta a una trampa SSH */
	'credencial-ssh': 'terminal',
	/* Clave privada SSH sembrada (H98): fichero de clave cebo atado a una trampa SSH */
	'clave-ssh-cebo': 'terminal',
	/* Web y portales */
	'login-web': 'web',
	'portal-vpn': 'web',
	'api-interna': 'web',
	'web-vulnerable': 'web',
	'proxy-http': 'web',
	/* URL trampa (H45): no corre servicio, es una URL cebo con baliza del relé */
	'url-trampa': 'web',
	/* Web clonada (H51/H52): snippet JS o CSS que delata el clonado por el Referer */
	'web-clonada-cebo': 'web',
	/* Consola de copias de seguridad (H85): consola web que imita Veeam/Nakivo */
	'consola-copias': 'web',
	/* Cookie de sesión cebo (H99): se reutiliza contra la consola de copias cebo */
	'cookie-sesion-cebo': 'web',
	/* Correo */
	correo: 'correo-electronico',
	/* Correo único sembrado (H53): dirección cebo cuyos mensajes caen en la trampa de correo */
	'correo-unico-cebo': 'correo-electronico',
	/* Servicios de red */
	'dns-ntp': 'red',
	sip: 'red',
	envenenador: 'red',
	darknet: 'red',
	escaneo: 'red',
	/* Nombre DNS sembrado (H50): su resolución cae en la trampa DNS (dns-ntp) */
	'nombre-dns-cebo': 'red',
	/* Directorio y llaves */
	/* Servicio de certificados de AD (H111): inscripción web que imita AD CS */
	'certificados-ad': 'directorio',
	'controlador-dominio': 'directorio',
	bmc: 'directorio',
	/* Certificado .pfx sembrado (H88): no corre servicio, su CDP es una baliza del relé */
	'certificado-cebo': 'directorio',
	/* Contenedores */
	/* Hipervisor falso (H86): ESXi, vCenter o Proxmox */
	hipervisor: 'contenedores',
	'api-docker': 'contenedores',
	/* Kubeconfig sembrado (H32): no corre servicio, su clúster es una baliza del relé */
	'kubeconfig-cebo': 'contenedores',
	/* Secret y cuenta de servicio de Kubernetes sembrados (H108): token cebo, baliza del relé */
	'secreto-k8s-cebo': 'contenedores',
	/* Impresoras, cámaras, IoT e industria */
	impresora: 'impresoras',
	'camara-ip': 'camaras',
	'broker-iot': 'iot',
	adb: 'iot',
	scada: 'industria',
	clima: 'industria',
	'plc-s7': 'industria',
	telecontrol: 'industria',
	'pasarela-ot': 'industria',
	'plc-ab': 'industria',
	/* Sanidad */
	pacs: 'sanidad',
	hl7: 'sanidad',
	/* Inteligencia artificial */
	mcp: 'ia',
	'api-ia': 'ia',
	/* Configuración MCP sembrada (H34): no corre servicio, apunta a una trampa MCP */
	'configuracion-mcp': 'ia',
	/* Chatbot interno falso (H95): asistente de IA con base RAG cebo y cadena canario */
	'chatbot-interno': 'ia',
	/* Código */
	git: 'codigo',
	svn: 'codigo',
	/* Secretos en el código (.env) sembrados (H94): no corre servicio, apunta a una trampa */
	'secretos-env': 'codigo',
	/* Registro de paquetes privado falso (H105): npm, PyPI y OCI/Docker en un contenedor */
	'registro-paquetes': 'codigo',
	/* Ficheros cebo con baliza */
	/* Paquete de botín con baliza (H104): archivo con un acceso de despliegue que apunta al relé */
	'paquete-cifrado-cebo': 'ficheros',
	/* Fichero técnico sembrado (H100-H102): tfstate, HAR o config con endpoint baliza del relé */
	'fichero-tecnico-cebo': 'ficheros',
	'fichero-word': 'ficheros',
	'fichero-excel': 'ficheros',
	'fichero-pdf': 'ficheros',
	'fichero-pptx': 'ficheros',
	'imagen-svg': 'ficheros',
	'centinela-ransomware': 'ficheros',
	'keepass-cebo': 'ficheros',
	'sysvol-cebo': 'ficheros',
	'carpeta-cebo': 'ficheros',
	'kerberoast-cebo': 'directorio',
	'usuario-ad-cebo': 'directorio',
	'laps-cebo': 'directorio',
	/* El receptor que recoge las balizas de esos ficheros */
	'receptor-balizas': 'ficheros',
	/* Retención: las que hacen perder el tiempo al intruso */
	'retencion-ssh': 'retencion',
	'retencion-web': 'retencion',
	/* Las honeycosas de nube de la tanda de conectores (H28–H31: aws-clave-cebo,
	 * azure-spn-cebo, login-clonado, app-saml), ya en modulos/nube/. */
	'aws-clave-cebo': 'nube',
	'azure-spn-cebo': 'nube',
	'login-clonado': 'nube',
	'app-saml': 'nube'
};

/* El tipo de servicio de un módulo, o null si no tiene (y lleva la abeja). */
export function tipoDeServicio(modulo: string | null | undefined): TipoDeServicio | null {
	return modulo && Object.hasOwn(TIPO_DE_TRAMPA, modulo) ? TIPO_DE_TRAMPA[modulo] : null;
}

/* Los módulos que tienen tipo, para que las pruebas los comparen con el catálogo. */
export const modulosConTipo = () => Object.keys(TIPO_DE_TRAMPA);
