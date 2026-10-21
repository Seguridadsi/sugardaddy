/*
 * Los motivos (docs/diseno/modulo-despliegue.md §7.4): por qué una vía no vale
 * en un destino, o de qué avisa. Cada uno tiene un código estable fase.causa
 * y una plantilla de texto en español para el cliente. Al panel, cuando la
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
	/* Para el cliente, en español. Lleva datos del cliente: se pinta escapado. */
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
		'modulo.desconocido': { texto: 'El módulo {modulo} no está en el catálogo.' },
		'modulo.no-autorizado': { texto: '{nombre} no entra en tu suscripción.' },
		'modulo.sin-vias': { texto: 'Esta honeycosa aún no tiene ninguna forma de ponerse.' },
		'modulo.via-desaparecida': {
			texto: 'La forma con que se puso ya no existe en el módulo; retírala y vuelve a ponerla.'
		},
		/* Trampas de pago cuyo candado (la licencia) no las deja arrancar (docs/diseno/licencias-de-pago.md). */
		'licencia.sin': { texto: 'Esta trampa de pago no está en tu licencia.' },
		'licencia.caducada': { texto: 'Tu licencia de pago ha caducado.' },
		'parametros.invalidos': { texto: '{errores}' },
		'ejecutor.desconocido': {
			texto: 'Esta forma ({ejecutor}) llegará con una versión más nueva de Sugardaddy.'
		},
		'destino.inactivo': { texto: '{destino} está dado de baja.' },
		'destino.tipo': { texto: 'Esta forma es para {tipos}; {destino} es {tipo}.' },
		/* El remedio lo elige el elector según plataforma.so (remedioAgenteFalta). */
		'agente.falta': { texto: 'Hace falta un sensor en {destino}.' },
		'agente.sin-ejecutor': {
			texto:
				'El sensor de {destino} aún no sabe hacer esto; se pondrá al día con su próxima versión.'
		},
		'agente.version': {
			texto:
				'Necesita un sensor {minimo} o posterior; este se pondrá al día con la próxima versión.'
		},
		'agente.anterior': {
			texto: 'Este sensor no dice cómo es su máquina; se da por hecho que despliega contenedores.'
		},
		'agente.sin-contacto': {
			texto: 'El sensor de {destino} no contesta; la trampa se pondrá cuando vuelva.'
		},
		'requisito.no-cumple': { texto: '{motivo} ({detalle}).' },
		'requisito.sin-dato': { texto: '{motivo} Falta el dato «{hecho}»: {comoSaberlo}.' },
		'senal.inalcanzable': { texto: 'Desde aquí no hay forma de leer lo que haga el atacante.' },
		'senal.trampa-objetivo': {
			texto: 'Necesita una trampa {modulos} puesta para recibir su señal.'
		},
		'senal.objetivo-sin-direccion': {
			texto: 'Lo sembrado tiene que apuntar a la dirección de {objetivo}, y {destino} no la tiene.',
			remedio: 'Pon la dirección de {destino} en Destinos.'
		},
		'senal.marca-repetida': {
			texto:
				'La trampa {otra} ya usa «{valor}» contra {objetivo}: elige otro valor para saber cuál de las dos se ha usado.'
		},
		'senal.objetivo-retirado': {
			texto: 'La trampa que recibía su señal ya no existe; retira esta y vuelve a ponerla con otra.'
		},
		'senal.objetivo-parado': {
			texto:
				'{objetivo} no está recibiendo ({estado}); mientras tanto, esta credencial no avisa de nada.'
		},
		'senal.objetivo-cambiado': {
			texto:
				'{objetivo} ha cambiado ({dato}); lo sembrado apunta a lo de antes. Retírala y vuelve a ponerla.'
		},
		'senal.sin-recolector': {
			texto:
				'Su señal sale del registro {canal} de {destino} y aún no hay recolector que lo lea (llega con el módulo de control).'
		},
		'senal.sin-rele': {
			texto: 'Su señal necesita un sensor con receptor de balizas en este nodo, y aún no lo tiene.'
		},
		'senal.sin-conexion': { texto: 'Hay que conectar {conexion} primero.' },
		'carga.imagen-sin-publicar': { texto: 'La imagen de esta trampa aún no está publicada.' },
		'carga.sin-credencial': {
			texto:
				'Este sensor aún no tiene la credencial del registro; se pondrá al día con su próxima versión.'
		},
		'puertos.ocupado': {
			texto: '{destino} ya usa el puerto {proto} {puerto}; elige otro o libéralo allí.'
		},
		'puertos.otra-trampa': {
			texto: 'El puerto {puerto} ya lo usa la trampa {nombre} en este destino.'
		},
		'puertos.reservado': {
			texto: 'El puerto {puerto} de este nodo es el de la consola: elige otro.'
		},
		'elector.sin-via': {
			texto: 'Ninguna forma de poner {nombre} vale en {destino}; mira el motivo de cada una.'
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
