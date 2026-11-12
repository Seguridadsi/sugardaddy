import { error, json } from '@sveltejs/kit';
import { catalogoPartnerFirmado } from '$lib/server/catalogo-partner';
import { sensorDe } from '$lib/server/sensor';

/*
 * El actualizador de un sensor remoto pide, con el token del sensor, el catálogo de trampas
 * del partner de su nodo (docs/diseno/trampas-de-partner.md). Él lo vuelve a comprobar con
 * sus claves y su PARTNER.
 */
export const GET = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'The local sensor gets it from its own updater');
	const catalogo = await catalogoPartnerFirmado();
	return catalogo ? json({ catalogo }) : json(null, { status: 404 });
};
