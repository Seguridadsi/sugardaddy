/*
 * Los motivos (docs/diseno/modulo-despliegue.md §7.4): por qué una vía no vale
 * en un destino, o de qué avisa. Cada uno tiene un código estable fase.causa
 * y una plantilla de texto en inglés para el cliente. Al panel, cuando la
 * telemetría lo pida, solo suben códigos y recuentos (escala.md, principio 7):
 * el texto se queda en la consola.
 *
 * Puro: sin ficheros, red ni reloj. Lo usan el elector, el plan (paso 8) y el
 * estado visible de una trampa (paso 10).
 */

export type CodigoMotivo =
	| 'modulo.desconocido'
	| 'modulo.no-autorizado'
	| 'modulo.sin-vias'
	| 'modulo.via-desaparecida'
	| 'licencia.sin'
	| 'licencia.caducada'
	| 'registro.sin'
	| 'registro.caducado'
	| 'parametros.invalidos'
	| 'ejecutor.desconocido'
	| 'destino.inactivo'
	| 'destino.tipo'
	| 'agente.falta'
	| 'agente.sin-ejecutor'
	| 'agente.version'
	| 'agente.anterior'
	| 'agente.sin-contacto'
	| 'requisito.no-cumple'
	| 'requisito.sin-dato'
	| 'senal.inalcanzable'
	| 'senal.trampa-objetivo'
	| 'senal.objetivo-sin-direccion'
	| 'senal.marca-repetida'
	| 'senal.objetivo-retirado'
	| 'senal.objetivo-parado'
	| 'senal.objetivo-cambiado'
	| 'senal.sin-recolector'
	| 'senal.sin-rele'
	| 'senal.sin-conexion'
	| 'carga.imagen-sin-publicar'
	| 'carga.sin-credencial'
	| 'puertos.ocupado'
	| 'puertos.otra-trampa'
	| 'puertos.reservado'
	| 'elector.sin-via';

export interface Motivo {
	codigo: CodigoMotivo;
	/* Para el cliente, en inglés. Lleva datos del cliente: se pinta escapado. */
	texto: string;
	/* El hecho que lo decide, lo que pedía el requisito y lo que vale (requisito.*). */
	hecho?: string;
	esperado?: unknown;
	valor?: unknown;
	remedio?: string;
}

/*
 * Plantillas: {dato} se sustituye por su valor. El remedio de un requisito
 * no está aquí: lo escribe el autor del módulo en el propio requisito.
 * Los que ya ve hoy el cliente en el plan conservan sus palabras.
 */
export const MOTIVOS: Readonly<Record<CodigoMotivo, { texto: string; remedio?: string }>> =
	Object.freeze({
		'modulo.desconocido': { texto: 'The module {modulo} is not in the catalog.' },
		'modulo.no-autorizado': { texto: '{nombre} is not part of your subscription.' },
		'modulo.sin-vias': { texto: 'This decoy has no way to be deployed yet.' },
		'modulo.via-desaparecida': {
			texto:
				'The method it was deployed with no longer exists in the module; remove it and deploy it again.'
		},
		/* Trampas de pago cuyo candado (la licencia) no las deja arrancar (docs/diseno/licencias-de-pago.md). */
		'licencia.sin': { texto: 'This Cloud decoy is not included in your license.' },
		'licencia.caducada': { texto: 'Your Cloud license has expired.' },
		/* Las que Community activa con el registro gratuito (docs/diseno/registro-community.md). */
		'registro.sin': {
			texto: 'This decoy is enabled for free with your registration, in Settings.'
		},
		'registro.caducado': { texto: 'Your registration has expired: renew it in Settings.' },
		'parametros.invalidos': { texto: '{errores}' },
		'ejecutor.desconocido': {
			texto: 'This method ({ejecutor}) will arrive with a newer version of Sugardaddy.'
		},
		'destino.inactivo': { texto: '{destino} has been removed.' },
		'destino.tipo': { texto: 'This method is for {tipos}; {destino} is {tipo}.' },
		/* El remedio lo elige el elector según plataforma.so (remedioAgenteFalta). */
		'agente.falta': { texto: 'A sensor is needed on {destino}.' },
		'agente.sin-ejecutor': {
			texto: 'The sensor on {destino} cannot do this yet; it will catch up with its next version.'
		},
		'agente.version': {
			texto: 'Needs sensor {minimo} or later; this one will update with the next version.'
		},
		'agente.anterior': {
			texto:
				'This sensor does not report what its machine is like; it is assumed to deploy containers.'
		},
		'agente.sin-contacto': {
			texto:
				'The sensor on {destino} is not responding; the decoy will be deployed when it returns.'
		},
		'requisito.no-cumple': { texto: '{motivo} ({detalle}).' },
		'requisito.sin-dato': { texto: '{motivo} The fact "{hecho}" is missing: {comoSaberlo}.' },
		'senal.inalcanzable': { texto: 'There is no way from here to read what the attacker does.' },
		'senal.trampa-objetivo': {
			texto: 'Needs a {modulos} decoy deployed to receive its signal.'
		},
		'senal.objetivo-sin-direccion': {
			texto: 'What is planted must point to the address of {objetivo}, and {destino} has none.',
			remedio: 'Set the address of {destino} in Targets.'
		},
		'senal.marca-repetida': {
			texto:
				'The decoy {otra} already uses "{valor}" against {objetivo}: choose another value to tell which of the two was used.'
		},
		'senal.objetivo-retirado': {
			texto:
				'The decoy that received its signal no longer exists; remove this one and deploy it again with another.'
		},
		'senal.objetivo-parado': {
			texto:
				'{objetivo} is not receiving ({estado}); until it does, this credential will not alert.'
		},
		'senal.objetivo-cambiado': {
			texto:
				'{objetivo} has changed ({dato}); what is planted points to the old one. Remove it and deploy it again.'
		},
		'senal.sin-recolector': {
			texto:
				'Its signal comes from {canal} on {destino}, and no collector reads it yet (it arrives with the control module).'
		},
		'senal.sin-rele': {
			texto:
				'Its signal needs a beacon receiver on this node or the relay of a node enrolled in Central, and it has neither yet.'
		},
		'senal.sin-conexion': { texto: '{conexion} must be connected first.' },
		'carga.imagen-sin-publicar': { texto: 'The image for this decoy has not been published yet.' },
		'carga.sin-credencial': {
			texto:
				'This sensor does not have the registry credential yet; it will catch up with its next version.'
		},
		'puertos.ocupado': {
			texto: '{destino} already uses {proto} port {puerto}; choose another or free it there.'
		},
		'puertos.otra-trampa': {
			texto: 'Port {puerto} is already used by the decoy {nombre} on this target.'
		},
		'puertos.reservado': {
			texto: 'Port {puerto} on this node is the console port: choose another.'
		},
		'elector.sin-via': {
			texto: 'No method of deploying {nombre} works on {destino}; check the reason for each one.'
		}
	});

export type DatosMotivo = Record<string, string | number>;

/*
 * Una sola pasada: un {x} que venga dentro de un dato (el nombre de una
 * trampa lo escribe el cliente) no se vuelve a sustituir.
 */
const rellenar = (plantilla: string, datos: DatosMotivo) =>
	plantilla.replace(/\{([A-Za-z]+)\}/g, (hueco, k: string) =>
		Object.hasOwn(datos, k) ? String(datos[k]) : hueco
	);

/*
 * El motivo con su texto. extra.remedio, si viene, sustituye al de la
 * plantilla (el de un requisito, el de agente.falta según la plataforma).
 */
export function motivo(
	codigo: CodigoMotivo,
	datos: DatosMotivo = {},
	extra: Omit<Motivo, 'codigo' | 'texto'> = {}
): Motivo {
	const { texto, remedio } = MOTIVOS[codigo];
	const { remedio: suyo, ...resto } = extra;
	const r = suyo ?? (remedio === undefined ? undefined : rellenar(remedio, datos));
	return {
		codigo,
		texto: rellenar(texto, datos),
		...resto,
		...(r === undefined ? {} : { remedio: r })
	};
}
