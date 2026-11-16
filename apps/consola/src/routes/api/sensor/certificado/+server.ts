import { error, json } from '@sveltejs/kit';
import { sensorDe } from '$lib/server/sensor';
import { CABECERA_HUELLA, CABECERA_MTLS, renovarConCsr } from '$lib/server/ca-sensores';

/*
 * El actualizador de un sensor remoto renueva aquí su certificado de cliente
 * (docs/diseno/mtls-sensores.md): manda una CSR con una clave nueva y recibe el
 * certificado firmado por la CA de sensores. sensorDe ya ha comprobado su token
 * y, si lo tiene, su certificado.
 */
export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(400, 'Only remote sensors use client certificates');
	const b = await request.json().catch(() => null);
	const presentada =
		request.headers.get(CABECERA_MTLS) === '1' ? (request.headers.get(CABECERA_HUELLA) ?? '') : '';
	const r = await renovarConCsr(sensor.id, b?.csr, presentada);
	if ('mensaje' in r) error(r.estado, r.mensaje);
	return json(r);
};
