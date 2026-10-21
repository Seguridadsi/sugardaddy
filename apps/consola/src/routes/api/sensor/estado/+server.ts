import { error, json } from '@sveltejs/kit';
import { leerCapacidades } from '@sugardaddy/contrato';
import { informarEstado, revisarCapacidades, sensorDe } from '$lib/server/sensor';

export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	const cuerpo = await request.json().catch(() => null);
	/* senuelos: el nombre que usan los sensores anteriores a la 0.8.0. */
	const trampas = cuerpo?.trampas ?? cuerpo?.senuelos;
	if (!Array.isArray(trampas)) error(400, 'Se esperaba { trampas: [...] }');
	/*
	 * motor y hechos: desde los sensores 0.13.1. Lo que no cuadre se descarta,
	 * queda en la auditoría y nunca da un 400.
	 */
	await informarEstado(sensor.id, trampas, leerCapacidades(cuerpo), revisarCapacidades(cuerpo));
	return json({ ok: true });
};
