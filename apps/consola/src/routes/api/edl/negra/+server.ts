import { text } from '@sveltejs/kit';
import { rechazoEdl } from '$lib/server/edl-acceso';
import { edl } from '$lib/server/inteligencia';

/*
 * Lista dinámica externa (EDL) para los firewalls: una IP o red por línea,
 * como la piden Palo Alto o Fortinet. El firewall la lee con su credencial
 * (edl-acceso.ts).
 */
export const GET = async ({ request }) => {
	const no = rechazoEdl(request);
	if (no) return no;
	return text((await edl()).join('\n') + '\n', {
		headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }
	});
};
