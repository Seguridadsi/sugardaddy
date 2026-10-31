import { error } from '@sveltejs/kit';
import { etiquetasModulos, nombresTrampas, perfilDeIp } from '$lib/server/consultas';

export const load = async ({ params }) => {
	/* SvelteKit ya entrega el parámetro decodificado; no se vuelve a decodificar. */
	const ip = params.ip.trim();
	const perfil = await perfilDeIp(ip);
	if (!perfil) error(404, 'No hay eventos de esa IP.');
	return {
		ahora: Date.now(),
		ip,
		...perfil,
		nombres: await nombresTrampas(),
		modulos: etiquetasModulos()
	};
};
