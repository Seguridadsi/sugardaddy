import { error } from '@sveltejs/kit';
import { logo } from '$lib/server/canal';

/*
 * El logotipo del cliente. Solo con sesión: la pantalla de entrada no dice
 * de quién es la consola.
 */
export const GET = async () => {
	const l = await logo();
	if (!l) error(404);
	return new Response(Buffer.from(l.datos, 'base64'), {
		headers: {
			'content-type': l.tipo,
			'x-content-type-options': 'nosniff',
			'cache-control': 'private, max-age=300'
		}
	});
};
