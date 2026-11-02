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
						? 'Demasiados intentos. Espera un cuarto de hora.'
						: 'Ese código no vale para este nodo.'
			});
		await abrir(
			cookies,
			{
				oid: 'emergencia:codigo',
				correo: 'emergencia · código',
				nombre: 'emergencia · código',
				roles: ['admin'],
				soporte: false
			},
			url.protocol === 'https:'
		);
		return { nuevo: r.nuevo };
	}
};
