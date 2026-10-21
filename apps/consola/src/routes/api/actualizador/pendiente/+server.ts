import { json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { actualizacion, retenido } from '$lib/server/canal';

/*
 * La versión firmada que toca instalar, tal como llegó. El actualizador vuelve
 * a verificar la firma. También se entrega si quedó "aplicando": un
 * actualizador que se reinició a medias la retoma, y los servicios que ya
 * tienen su imagen se saltan.
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	/* Mientras un auxiliar aplica la configuración, nada nuevo. */
	if (await retenido()) return json(null);
	const a = await actualizacion();
	const toca = a.estado === 'pendiente' || a.estado === 'aplicando';
	return json(toca ? { version: a.version, release: a.release } : null);
};
