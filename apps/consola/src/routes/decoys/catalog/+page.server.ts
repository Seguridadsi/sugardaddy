import { tipoEvento } from '@sugardaddy/contrato';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { catalogoConSuscripcion, desplegable, porQueNo } from '$lib/server/catalogo';
import { usoDeModulos } from '$lib/server/consultas';
import { madurezDelNodo, vistaDeMadurez } from '$lib/server/madurez';
import { plantillasDisponibles } from '$lib/server/plantillas';

/*
 * El catálogo de trampas para añadir nuevas. Las ya puestas viven en /decoys;
 * aquí se marca cuántas hay de cada módulo para no ofrecer a ciegas.
 *
 * Orden: las instaladas delante, luego las disponibles (en la suscripción y, si
 * son de pago, en la licencia) y, dentro de cada grupo, por nombre.
 */
export const load = async () => {
	const [catalogo, uso, madurez] = await Promise.all([
		catalogoConSuscripcion(),
		usoDeModulos(),
		madurezDelNodo()
	]);
	const instaladas = new Map([...uso].map(([modulo, u]) => [modulo, u.instaladas]));
	return {
		/* Las plantillas son de Cloud: en Community no se ofrecen. */
		conPlantillas: plantillasDisponibles(),
		catalogo: catalogo
			.toSorted(
				(a, b) =>
					Number(instaladas.has(b.id)) - Number(instaladas.has(a.id)) ||
					Number(b.disponible) - Number(a.disponible) ||
					a.nombre.localeCompare(b.nombre, 'en')
			)
			.map((m) => ({
				id: m.id,
				nombre: m.nombre,
				tipo: tipoEvento(m),
				disponible: m.disponible,
				instaladas: instaladas.get(m.id) ?? 0,
				enMarcha: uso.get(m.id)?.enMarcha ?? 0,
				/* La madurez firmada con la versión del nodo (D11): el nivel y sus textos, o null. */
				madurez: ((v) => v && { nivel: v.nivel, etiqueta: v.etiqueta, explicacion: v.explicacion })(
					vistaDeMadurez(madurez, m)
				),
				porQueNo: porQueNo(m),
				activarConRegistro: !m.disponible && m.conRegistro,
				registroCaducado: m.licencia === 'registro.caducado',
				/* Tiene alguna vía que esta consola sabe poner (en un sensor o a mano). */
				desplegable: desplegable(m),
				resumen: m.ficha?.detecta ?? m.descripcion,
				procedencia: m.procedencia ?? null,
				pictograma: tipoDeServicio(m.id)
			}))
	};
};
