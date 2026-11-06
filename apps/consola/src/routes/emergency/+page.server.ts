import { fail } from '@sveltejs/kit';
import { abrir } from '$lib/server/auth/sesion';
import { canjearCodigoEmergencia } from '$lib/server/emergencia';

/*
 * Entrar con el código de emergencia (el que enseñó el instalador). No se
 * redirige: la respuesta trae el código siguiente, que hay que enseñar una vez
 * antes de seguir, porque el que se ha usado ya no vale.
 */
export const actions = {
	codigo: async ({ request, cookies, url, getClientAddress }) => {
		const codigo = String((await request.formData()).get('codigo') ?? '').slice(0, 80);
		const r = await canjearCodigoEmergencia(codigo, getClientAddress());
		if (!r.ok)
			return fail(r.motivo === 'frenado' ? 429 : 400, {
				error:
					r.motivo === 'frenado'
						? 'Too many attempts. Wait 15 minutes.'
						: 'That code is not valid for this node.'
			});
		await abrir(
			cookies,
			{
				oid: 'emergencia:codigo',
				correo: 'emergency · code',
				nombre: 'emergency · code',
				roles: ['admin'],
				soporte: false
			},
			url.protocol === 'https:'
		);
		return { nuevo: r.nuevo };
	}
};
