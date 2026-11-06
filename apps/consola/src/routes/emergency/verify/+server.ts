import { error, json } from '@sveltejs/kit';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';
import { verificarEntrada } from '$lib/server/emergencia';

/* Entrar con la llave: rol de administrador, y que se sepa. */
export const POST = async ({ url, cookies, request }) => {
	const llave = await verificarEntrada(
		cookies.get('sd_reto'),
		await request.json(),
		url.origin,
		url.hostname
	);
	cookies.delete('sd_reto', { path: '/emergency' });
	if (!llave) {
		await auditar('anonymous', 'emergency sign-in failed');
		error(401, 'The key is not valid for this node');
	}
	const quien = `emergency · ${llave.nombre}`;
	await abrir(
		cookies,
		{
			oid: `emergencia:${llave.id}`,
			correo: quien,
			nombre: quien,
			roles: ['admin'],
			soporte: false
		},
		url.protocol === 'https:'
	);
	await auditar(quien, 'EMERGENCY SIGN-IN', { llave: llave.nombre });
	return json({ ok: true });
};
