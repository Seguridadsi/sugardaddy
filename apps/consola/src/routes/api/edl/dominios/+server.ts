import { timingSafeEqual } from 'node:crypto';
import { error, text } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { edlDominios } from '$lib/server/inteligencia';

/*
 * Lista dinámica externa (EDL) de DOMINIOS para filtros de DNS, proxies web y
 * NGFW: un dominio por línea. El cliente la lee con el mismo token que la de
 * IPs (EDL_TOKEN). Espejo de /api/edl/negra.
 */
export const GET = async ({ request }) => {
	const esperado = env.EDL_TOKEN;
	if (!esperado || esperado.length < 32) error(503, 'La lista para firewalls no está configurada');
	const dado = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
	const b = Buffer.from(esperado);
	if (dado.length !== b.length || !timingSafeEqual(dado, b)) error(401, 'Token no válido');
	return text((await edlDominios()).join('\n') + '\n', {
		headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }
	});
};
