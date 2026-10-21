import { listaDestinos } from '$lib/server/destinos';

export const load = async ({ url }) => ({
	ahora: Date.now(),
	baja: url.searchParams.has('baja'),
	destinos: await listaDestinos()
});
