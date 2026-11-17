import { error, json } from '@sveltejs/kit';
import { ambitoSensor, recibirAuditd } from '$lib/server/anfitrion';
import { sensorDe } from '$lib/server/sensor';

/* Los eventos de auditd de la máquina de un sensor remoto (claves sd-*), a la auditoría. */
export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'The local sensor shares the node machine');
	const n = await recibirAuditd(await request.json().catch(() => null), ambitoSensor(sensor));
	if (n === null) error(400, 'Expected { eventos: [...], omitidos }');
	return json({ ok: true, apuntados: n });
};
