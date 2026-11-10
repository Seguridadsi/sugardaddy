import { error, json } from '@sveltejs/kit';
import { versionFirmadaDe } from '$lib/server/canal';
import { sensorDe } from '$lib/server/sensor';

/*
 * El actualizador de un sensor remoto pide, con el token del sensor, la versión firmada de la
 * que tiene instalada si su máquina no la tiene: solo si es la del nodo, que es la que manda
 * los manifiestos. Él la vuelve a comprobar con sus claves (docs/diseno/claves-y-catalogo.md).
 */
export const GET = async ({ request, url }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'The local sensor gets it from its own updater');
	const release = await versionFirmadaDe(url.searchParams.get('version') ?? '');
	return release ? json({ release }) : json(null, { status: 404 });
};
