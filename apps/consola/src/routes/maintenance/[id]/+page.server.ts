import { error } from '@sveltejs/kit';
import {
	nombresObjetivos,
	resumenMantenimiento,
	textoAlcance,
	ventanaMantenimiento
} from '$lib/server/mantenimiento';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* El resumen de una ventana: el guardado al terminar o, si sigue en curso, el de hasta ahora. */
export const load = async ({ params }) => {
	if (!UUID.test(params.id)) error(404, 'That maintenance window does not exist.');
	const v = await ventanaMantenimiento(params.id);
	if (!v) error(404, 'That maintenance window does not exist.');
	const ahora = new Date();
	if (v.desde > ahora) error(404, 'That maintenance window has not started yet.');
	return {
		nombre: v.nombre,
		alcance: textoAlcance(v, await nombresObjetivos([v])),
		desde: v.desde.toISOString(),
		hasta: v.hasta.toISOString(),
		nota: v.nota,
		quien: v.quien,
		cerradaPor: v.cerradaPor,
		enCurso: !v.resumen,
		resumen:
			v.resumen ??
			(await resumenMantenimiento(
				{ ...v, hasta: v.hasta < ahora ? v.hasta : ahora },
				ahora.getTime()
			))
	};
};
