/*
 * La configuración inicial de la consola (/setup): la lista de pasos que ve quien
 * administra al entrar por primera vez, y en qué estado está cada uno.
 *
 * Casi todos los pasos salen solos de lo que ya hay en el nodo (la lista de acceso, el
 * dominio, una trampa puesta…). Dos no se pueden deducir y los confirma la persona: que
 * ha guardado el código de emergencia y que ha instalado la raíz del certificado. Eso, lo
 * que deja para más adelante y si ya ha terminado es lo único que se guarda.
 */

export type IdPaso =
	'cuenta' | 'acceso' | 'codigo' | 'empresa' | 'registro' | 'avisos' | 'certificado' | 'trampa';

export type EstadoPaso = 'hecho' | 'omitido' | 'pendiente';

/* Lo que se guarda en `ajustes`. */
export type Guardado = {
	/* Ya se le ha enseñado el asistente: no se le vuelve a llevar a él. */
	visto: boolean;
	confirmados: Partial<Record<IdPaso, 'hecho' | 'omitido'>>;
	terminado: string | null;
};

export const SIN_EMPEZAR: Guardado = { visto: false, confirmados: {}, terminado: null };

/* Lo que se sabe del nodo sin preguntar a nadie. */
export type Hechos = {
	community: boolean;
	/* Entra con usuario y contraseña de la consola (no con Microsoft ni por emergencia). */
	cuentaLocal: boolean;
	acceso: 'pendiente' | 'restringida' | 'abierta';
	hayCodigo: boolean;
	dominioDecidido: boolean;
	dominio: string | null;
	/* Community sin panel: se puede registrar. */
	puedeRegistrarse: boolean;
	registrado: boolean;
	registroDecidido: boolean;
	hayAvisos: boolean;
	/* El HTTPS de la consola sale de la raíz propia del nodo (no de un certificado del cliente). */
	raizPropia: boolean;
	hayTrampa: boolean;
	trampaProbada: boolean;
};

export type Paso = {
	id: IdPaso;
	estado: EstadoPaso;
	/* Se puede dejar para más adelante. */
	omitible: boolean;
	/* Lo confirma la persona: no hay forma de saberlo desde el nodo. */
	manual: boolean;
};

/* Los pasos que se pueden confirmar a mano y los que se pueden dejar para más adelante. */
export const MANUALES: readonly IdPaso[] = ['codigo', 'certificado'];
export const OMITIBLES: readonly IdPaso[] = [
	'empresa',
	'registro',
	'avisos',
	'certificado',
	'trampa'
];

export function pasos(h: Hechos, g: Guardado): Paso[] {
	const de = (hecho: boolean, id: IdPaso): EstadoPaso =>
		hecho ? 'hecho' : g.confirmados[id] === 'omitido' ? 'omitido' : 'pendiente';
	const paso = (id: IdPaso, estado: EstadoPaso): Paso => ({
		id,
		estado,
		omitible: OMITIBLES.includes(id),
		manual: MANUALES.includes(id)
	});

	const lista: Paso[] = [
		/* Quien ve esta página ya ha entrado: con su contraseña nueva o con su cuenta de Microsoft. */
		paso('cuenta', 'hecho'),
		paso('acceso', h.acceso === 'pendiente' ? 'pendiente' : 'hecho'),
		paso('codigo', h.hayCodigo && g.confirmados.codigo === 'hecho' ? 'hecho' : 'pendiente'),
		paso(
			'empresa',
			h.dominio
				? 'hecho'
				: h.dominioDecidido || g.confirmados.empresa === 'omitido'
					? 'omitido'
					: 'pendiente'
		)
	];
	if (h.community) {
		if (h.puedeRegistrarse)
			lista.push(
				paso(
					'registro',
					h.registrado
						? 'hecho'
						: h.registroDecidido || g.confirmados.registro === 'omitido'
							? 'omitido'
							: 'pendiente'
				)
			);
	} else lista.push(paso('avisos', de(h.hayAvisos, 'avisos')));
	if (h.raizPropia)
		lista.push(paso('certificado', de(g.confirmados.certificado === 'hecho', 'certificado')));
	lista.push(paso('trampa', de(h.hayTrampa && h.trampaProbada, 'trampa')));
	return lista;
}

export const pendientes = (lista: Paso[]) => lista.filter((p) => p.estado === 'pendiente');
