import { json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { actualizacion, retenido } from '$lib/server/canal';
import {
	aprobacionActualizacion,
	esperaActual,
	politicaActualizacion
} from '$lib/server/politica-actualizacion';

/*
 * La versión firmada que toca instalar, tal como llegó. El actualizador vuelve
 * a verificar la firma. También se entrega si quedó "aplicando": un
 * actualizador que se reinició a medias la retoma, y los servicios que ya
 * tienen su imagen se saltan.
 *
 * Política de cambios (docs/diseno/politica-cambios.md): mientras espere la
 * aprobación o el retardo, no se entrega. Cuando se entrega, va con la política
 * y la aprobación, y el actualizador repite la cuenta con su suelo local: la
 * consola informa, él decide.
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	/* Mientras un auxiliar aplica la configuración, nada nuevo. */
	if (await retenido()) return json(null);
	const a = await actualizacion();
	const toca = a.estado === 'pendiente' || a.estado === 'aplicando';
	if (!toca) return json(null);
	if ((await esperaActual(a)).motivo) return json(null);
	const aprobada = await aprobacionActualizacion();
	return json({
		version: a.version,
		release: a.release,
		politica: await politicaActualizacion(),
		aprobacion: aprobada?.version === a.version ? aprobada : null
	});
};
