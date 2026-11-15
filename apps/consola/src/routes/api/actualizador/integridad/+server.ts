import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { leerInforme, recibirIntegridad } from '$lib/server/integridad';

/*
 * El actualizador cuenta lo que no casa entre la máquina y su versión firmada
 * (lib/server/integridad.ts). Una lista vacía es que todo casa.
 */
export const POST = async ({ request }) => {
	exigirActualizador(request);
	const informe = leerInforme(await request.json().catch(() => null));
	if (!informe) error(400, 'Expected { version, desviaciones: [{ tipo, detalle }] }');
	return json({ ok: true, cambio: await recibirIntegridad(informe) });
};
