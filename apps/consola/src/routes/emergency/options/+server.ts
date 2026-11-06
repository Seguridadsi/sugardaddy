import { error, json } from '@sveltejs/kit';
import { sinLlavePorIp } from '$lib/llave-por-ip';
import { opcionesEntrada } from '$lib/server/emergencia';

export const POST = async ({ url, cookies }) => {
	const porIp = sinLlavePorIp(url.hostname);
	if (porIp) error(400, porIp);
	const r = await opcionesEntrada(url.hostname);
	if (!r) error(404, 'This node has no emergency key registered');
	cookies.set('sd_reto', r.reto, {
		path: '/emergency',
		httpOnly: true,
		sameSite: 'strict',
		secure: url.protocol === 'https:',
		maxAge: 300
	});
	return json(r.opciones);
};
