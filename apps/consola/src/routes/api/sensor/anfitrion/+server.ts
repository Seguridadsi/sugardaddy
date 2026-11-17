import { error, json } from '@sveltejs/kit';
import { ambitoSensor, leerHechos, paraElSensor, recibirHechos } from '$lib/server/anfitrion';
import { sensorDe } from '$lib/server/sensor';

/*
 * La máquina de un sensor remoto (lib/server/anfitrion.ts, docs/diseno/cortafuegos-anfitrion.md),
 * con el token del sensor: lo mismo que /api/actualizador/anfitrion para el nodo. GET: qué
 * tiene que dejar su cortafuegos estricto. POST: lo que su actualizador ve de la máquina.
 */
export const GET = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'The local sensor shares the node machine');
	return json(await paraElSensor(sensor));
};

export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'The local sensor shares the node machine');
	const h = leerHechos(await request.json().catch(() => null));
	if (!h) error(400, 'Expected { docker: { version, fijada, desfasada }, maquina? }');
	return json({ ok: true, cambios: await recibirHechos(h, ambitoSensor(sensor)) });
};
