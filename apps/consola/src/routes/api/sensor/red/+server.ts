import { json } from '@sveltejs/kit';
import { leerRed, leerVlan } from '$lib/red';
import { redDetectada } from '$lib/server/gestion';
import { sensorDe } from '$lib/server/sensor';

const texto = (v: unknown) => (typeof v === 'string' ? v : '');

/*
 * El instalador de un sensor remoto cuenta aquí, con el token del sensor, la
 * red y la VLAN que ve en su máquina (detectarRed). Lo que no se entiende no
 * se guarda, y lo que ya tiene el sensor no se toca: nunca da un 400.
 */
export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	const cuerpo = await request.json().catch(() => null);
	const guardada = await redDetectada(sensor.id, {
		red: leerRed(texto(cuerpo?.red)) ?? null,
		vlan: leerVlan(texto(cuerpo?.vlan)) ?? null
	});
	return json({ guardada });
};
