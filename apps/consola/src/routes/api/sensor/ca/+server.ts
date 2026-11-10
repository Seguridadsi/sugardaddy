import { error, json } from '@sveltejs/kit';
import { apuntarRaicesSensor, raicesParaSensores } from '$lib/server/ca-nodo';
import { sensorDe } from '$lib/server/sensor';

/*
 * El actualizador de un sensor remoto pregunta en qué raíces tiene que confiar
 * para hablar con la consola (docs/diseno/ca-nodo.md) y dice cuáles tiene (el
 * sha256 de su ca-consola.crt). null: que no toque nada (la consola usa un
 * certificado de la empresa, o aún no hay raíz).
 */
export const GET = async ({ request, url }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'The local sensor talks to the console inside the node');
	await apuntarRaicesSensor(sensor.id, url.searchParams.get('tiene'));
	return json({ raices: await raicesParaSensores() });
};
