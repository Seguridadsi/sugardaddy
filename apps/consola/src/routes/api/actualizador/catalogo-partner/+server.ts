import { json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { catalogoPartnerFirmado } from '$lib/server/catalogo-partner';

/*
 * El actualizador del nodo pide el catálogo de trampas del partner para dejárselo al sensor
 * (docs/diseno/trampas-de-partner.md). La consola solo entrega: él vuelve a comprobar la
 * cadena con sus claves y su PARTNER, y no acepta uno más viejo que el que tiene.
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	const catalogo = await catalogoPartnerFirmado();
	return catalogo ? json({ catalogo }) : json(null, { status: 404 });
};
