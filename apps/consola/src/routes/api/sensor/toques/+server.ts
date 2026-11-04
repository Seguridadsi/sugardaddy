import { error, json } from '@sveltejs/kit';
import { sensorDe } from '$lib/server/sensor';
import { anotarToque } from '$lib/server/toques';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* El sensor cuenta cómo ha ido un toque de «Prueba mi detección» (toques.ts). */
export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	const d = await request.json().catch(() => null);
	if (!d || typeof d.id !== 'string' || !UUID.test(d.id) || typeof d.ok !== 'boolean')
		error(400, 'Toque mal formado');
	await anotarToque(sensor.id, d.id, d.ok, typeof d.detalle === 'string' ? d.detalle : null);
	return json({ ok: true });
};
