import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { abiertaPorEmergencia, guardarCortafuegos, paraElCortafuegos } from '$lib/server/acceso';

/*
 * El actualizador pregunta a quién deja pasar el cortafuegos de la máquina
 * (docs/diseno/acceso-consola.md) y cuenta lo que ha aplicado.
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	return json(await paraElCortafuegos());
};

export const POST = async ({ request }) => {
	exigirActualizador(request);
	const b = await request.json().catch(() => null);
	if (!b || typeof b.estado !== 'string') error(400, 'Expected { estado, detalle }');
	const detalle = typeof b.detalle === 'string' ? b.detalle : '';
	const huella = typeof b.huella === 'string' ? b.huella : null;
	if (!(await guardarCortafuegos(b.estado, detalle, huella))) error(400, 'Unknown state');
	/* El puerto se abrió con el fichero de emergencia: la consola pasa a «abierta» y lo dice. */
	if (b.emergencia === true && b.estado === 'abierta') await abiertaPorEmergencia();
	return json({ ok: true });
};
