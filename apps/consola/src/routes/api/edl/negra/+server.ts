import { timingSafeEqual } from 'node:crypto';
import { error, text } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { edl } from '$lib/server/inteligencia';

/*
 * Lista dinámica externa (EDL) para los firewalls: una IP o red por línea,
 * como la piden Palo Alto o Fortinet. El firewall la lee con su propio token.
 */
export const GET = async ({ request }) => {
	const esperado = env.EDL_TOKEN;
	if (!esperado || esperado.length < 32) error(503, 'La lista para firewalls no está configurada');
	const dado = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
	const b = Buffer.from(esperado);
	if (dado.length !== b.length || !timingSafeEqual(dado, b)) error(401, 'Token no válido');
	return text((await edl()).join('\n') + '\n', {
		headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }
	});
};
