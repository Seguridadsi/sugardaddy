import { redirect } from '@sveltejs/kit';
import {
	generarEstado,
	generarVerificador,
	urlDeAutorizacion,
	volverSeguro
} from '@sugardaddy/entra';
import { exigir } from '$lib/server/auth/permisos';
import { COOKIE_OIDC } from '$lib/server/auth/entra';
import { configActiva, configPropia } from '$lib/server/auth/entra-propio';

/*
 * Ida a Microsoft. Con ?probar, un administrador ya dentro prueba el Entra
 * propio que acaba de guardar en Ajustes (aún pendiente): si vuelve bien, se
 * activa (auth/callback).
 */
export const GET = async ({ url, cookies, locals }) => {
	const probar = url.searchParams.has('probar');
	if (probar) exigir(locals, 'ajustes');
	else if (locals.usuario) redirect(303, '/');
	const config = probar ? await configPropia() : (await configActiva())?.config;
	if (!config) redirect(303, probar ? '/ajustes?entra=sin-config#entra' : '/entrar');

	const estado = generarEstado();
	const nonce = generarEstado();
	const verificador = generarVerificador();
	cookies.set(
		COOKIE_OIDC,
		JSON.stringify({
			estado,
			nonce,
			verificador,
			probar,
			volverA: volverSeguro(url.searchParams.get('volverA'))
		}),
		{ path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600 }
	);
	redirect(
		303,
		await urlDeAutorizacion(config, {
			redirectUri: `${url.origin}/auth/callback`,
			estado,
			nonce,
			verificador
		})
	);
};
