import { error, json } from '@sveltejs/kit';
import { LIMITE_ENTREGA, LIMITE_LINEAS, recibirEventos, sensorDe } from '$lib/server/sensor';

/*
 * Los eventos llegan como NDJSON: una línea por evento, tal cual las emitió el
 * sensor. No se reserializa nada, porque el hash es de esos bytes.
 */
export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!request.headers.get('content-type')?.startsWith('application/x-ndjson'))
		error(415, 'Se esperaba application/x-ndjson');
	const texto = await request.text();
	if (texto.length > LIMITE_ENTREGA) error(413, 'Entrega demasiado grande');
	const lineas = texto.split('\n').filter((l) => l.length > 0);
	if (lineas.length > LIMITE_LINEAS) error(413, `Como mucho ${LIMITE_LINEAS} eventos por entrega`);

	return json(await recibirEventos(sensor.id, lineas));
};
