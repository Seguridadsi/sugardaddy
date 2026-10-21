import { error, json } from '@sveltejs/kit';
import { opcionesEntrada } from '$lib/server/emergencia';

export const POST = async ({ url, cookies }) => {
	const r = await opcionesEntrada(url.hostname);
	if (!r) error(404, 'Este nodo no tiene ninguna llave de emergencia registrada');
	cookies.set('sd_reto', r.reto, {
		path: '/emergencia',
		httpOnly: true,
		sameSite: 'strict',
		secure: url.protocol === 'https:',
		maxAge: 300
	});
	return json(r.opciones);
};
