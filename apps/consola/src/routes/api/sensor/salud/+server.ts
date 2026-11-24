import { error, json } from '@sveltejs/kit';
import { sensorDe } from '$lib/server/sensor';
import { guardarMuestra, leerMuestra } from '$lib/server/salud-maquina';

/*
 * La muestra de salud de un sensor, cada minuto (docs/diseno/salud.md): su
 * máquina y cómo están sus trampas. Lo que no cuadre se descarta con un 400:
 * el sensor no reintenta, manda otra al minuto siguiente.
 */
export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	const muestra = leerMuestra(await request.json().catch(() => null));
	if (!muestra) error(400, 'Expected a health sample');
	await guardarMuestra(sensor.id, muestra);
	return json({ ok: true });
};
