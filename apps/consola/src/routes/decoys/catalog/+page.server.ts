import { tipoEvento } from '@sugardaddy/contrato';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { catalogoConSuscripcion, desplegable, porQueNo } from '$lib/server/catalogo';
import { trampasConEventos } from '$lib/server/consultas';
import { plantillasDisponibles } from '$lib/server/plantillas';

/*
 * El catálogo de trampas para añadir nuevas. Las ya puestas viven en /decoys;
 * aquí se marca cuántas hay de cada módulo para no ofrecer a ciegas.
 *
 * Orden: las instaladas delante, luego las disponibles (en la suscripción y, si
 * son de pago, en la licencia) y, dentro de cada grupo, por nombre.
 */
export const load = async () => {
	const catalogo = await catalogoConSuscripcion();
	const desplegados = await trampasConEventos();
	const instaladas = new Map<string, number>();
	for (const t of desplegados) instaladas.set(t.modulo, (instaladas.get(t.modulo) ?? 0) + 1);
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
