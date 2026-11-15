/*
 * Los canales de salida que son un SIEM o un almacén de registros: ahí la
 * auditoría de la consola va sin pedirla (quiereAuditoria, salidas/reglas.ts).
 * Aparte para que lo use también el formulario del navegador.
 */
export const CANALES_SIEM: readonly string[] = [
	'syslog',
	'sentinel',
	'webhook',
	'elastic-ecs',
	'graylog-gelf'
];
