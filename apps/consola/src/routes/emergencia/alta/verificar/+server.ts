import { error, json } from '@sveltejs/kit';
import { registrar } from '$lib/server/emergencia';

export const POST = async ({ url, cookies, request }) => {
	const r = await registrar(
		cookies.get('sd_reto'),
		await request.json(),
		url.origin,
		url.hostname,
		cookies.get('sd_alta_codigo') === '1'
	);
	cookies.delete('sd_reto', { path: '/emergencia' });
	cookies.delete('sd_alta_codigo', { path: '/emergencia' });
	if (!r.ok) error(400, r.motivo);
	return json({ ok: true });
};
