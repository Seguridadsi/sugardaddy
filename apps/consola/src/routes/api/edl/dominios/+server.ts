import { text } from '@sveltejs/kit';
import { rechazoEdl } from '$lib/server/edl-acceso';
import { edlDominios } from '$lib/server/inteligencia';

/*
 * Lista dinámica externa (EDL) de DOMINIOS para filtros de DNS, proxies web y
 * NGFW: un dominio por línea. La misma credencial que la de IPs. Espejo de
 * /api/edl/negra.
 */
export const GET = async ({ request }) => {
	const no = rechazoEdl(request);
	if (no) return no;
	return text((await edlDominios()).join('\n') + '\n', {
		headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }
	});
};
