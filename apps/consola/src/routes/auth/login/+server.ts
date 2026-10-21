import { redirect } from '@sveltejs/kit';
import {
	generarEstado,
	generarVerificador,
	urlDeAutorizacion,
	volverSeguro
} from '@sugardaddy/entra';
import { COOKIE_OIDC, config } from '$lib/server/auth/entra';

export const GET = async ({ url, cookies, locals }) => {
	if (locals.usuario) redirect(303, '/');
	const estado = generarEstado();
	const nonce = generarEstado();
	const verificador = generarVerificador();
	cookies.set(
		COOKIE_OIDC,
		JSON.stringify({
			estado,
			nonce,
			verificador,
			volverA: volverSeguro(url.searchParams.get('volverA'))
		}),
		{ path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600 }
	);
	redirect(
		303,
		await urlDeAutorizacion(config(), {
			redirectUri: `${url.origin}/auth/callback`,
			estado,
			nonce,
			verificador
		})
	);
};
