import { error, json } from '@sveltejs/kit';
import { informarRelevo, relevoPermitido } from '$lib/server/canal';
import { sensorDe } from '$lib/server/sensor';

/*
 * El relevo de la 0.11: un sensor nuevo pide permiso para pasar su máquina a
 * la configuración firmada de la versión del nodo (y dice cómo va). Es la
 * consola quien sabe si el actualizador viejo está a mitad de algo.
 */
export const GET = async ({ request }) => {
	const sensor = await sensorDe(request);
	return json(await relevoPermitido(sensor));
};

export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	const b = await request.json().catch(() => null);
	if (!['aplicando', 'fallida', 'cancelado'].includes(b?.estado))
		error(400, 'Se esperaba { estado, detalle }');
	// 409: sin cerrojo. El sensor no toca nada.
	if (!(await informarRelevo(sensor, b.estado, String(b.detalle ?? ''))))
		error(409, 'No toca: hay otro relevo en curso o ya no hace falta');
	return json({ ok: true });
};
