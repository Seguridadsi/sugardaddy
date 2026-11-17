import { error, json } from '@sveltejs/kit';
import { ambitoSensor, recibirEstricto } from '$lib/server/anfitrion';
import { sensorDe } from '$lib/server/sensor';

/* Cómo ha quedado el cortafuegos estricto de la máquina de un sensor remoto. */
export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'The local sensor shares the node machine');
	if (!(await recibirEstricto(await request.json().catch(() => null), ambitoSensor(sensor))))
		error(400, 'Expected { estado, detalle, huella }');
	return json({ ok: true });
};
