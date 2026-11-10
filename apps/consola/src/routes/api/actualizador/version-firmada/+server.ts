import { json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { versionFirmadaDe } from '$lib/server/canal';

/*
 * El actualizador del nodo pide la versión firmada de la que tiene instalada cuando la
 * máquina no la tiene (una instalación nueva), para dejársela al sensor con su catálogo
 * (docs/diseno/claves-y-catalogo.md). Él la vuelve a comprobar con sus claves.
 */
export const GET = async ({ request, url }) => {
	exigirActualizador(request);
	const release = await versionFirmadaDe(url.searchParams.get('version') ?? '');
	return release ? json({ release }) : json(null, { status: 404 });
};
