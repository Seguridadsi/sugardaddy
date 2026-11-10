import { error, json } from '@sveltejs/kit';
import { leerCapacidades } from '@sugardaddy/contrato';
import { informarEstado, revisarCapacidades, sensorDe } from '$lib/server/sensor';
import { apuntarDireccionSensor } from '$lib/server/acceso';

export const POST = async ({ request, getClientAddress }) => {
	const sensor = await sensorDe(request);
	/*
	 * Desde dónde llega un sensor remoto (por Caddy, con X-Forwarded-For): con el
	 * acceso a la consola limitado, su máquina tiene que estar en la lista.
	 */
	if (sensor.remoto && request.headers.has('x-forwarded-for'))
		await apuntarDireccionSensor(sensor.id, getClientAddress);
	const cuerpo = await request.json().catch(() => null);
	/* senuelos: el nombre que usan los sensores anteriores a la 0.8.0. */
	const trampas = cuerpo?.trampas ?? cuerpo?.senuelos;
	if (!Array.isArray(trampas)) error(400, 'Expected { trampas: [...] }');
	/*
	 * motor y hechos: desde los sensores 0.13.1. Lo que no cuadre se descarta,
	 * queda en la auditoría y nunca da un 400.
	 */
	await informarEstado(sensor.id, trampas, leerCapacidades(cuerpo), revisarCapacidades(cuerpo));
	return json({ ok: true });
};
