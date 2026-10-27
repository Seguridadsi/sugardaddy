import { listaDestinos } from '$lib/server/destinos';
import { esCommunity } from '$lib/server/edicion';

export const load = async ({ url }) => ({
	ahora: Date.now(),
	baja: url.searchParams.has('baja'),
	/* En community no se añaden destinos a mano (no hay señuelos manuales). */
	community: esCommunity(),
	destinos: await listaDestinos()
});
