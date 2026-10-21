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
	cookies.delete('sd_reto', { path: '/emergencia' });
	if (!llave) {
		await auditar('anónimo', 'entrada de emergencia fallida');
		error(401, 'La llave no es válida para este nodo');
	}
	const quien = `emergencia · ${llave.nombre}`;
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
	await auditar(quien, 'ENTRADA DE EMERGENCIA', { llave: llave.nombre });
	return json({ ok: true });
};
