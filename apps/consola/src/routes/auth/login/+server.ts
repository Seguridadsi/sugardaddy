import { redirect } from '@sveltejs/kit';
import {
	CONTEXTO_AUTH,
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
 * activa (auth/callback). Con ?probar&activarMfa, la prueba es para activar la
 * exigencia de MFA en una configuración heredada, con el contexto de
 * autenticación que se quiera usar (?contexto=c1): solo se guarda si el token
 * vuelve con MFA.
 */
export const GET = async ({ url, cookies, locals }) => {
	const probar = url.searchParams.has('probar');
	if (probar) exigir(locals, 'ajustes');
	else if (locals.usuario) redirect(303, '/');
	const activarMfa = probar && url.searchParams.has('activarMfa');
	const pedido = (url.searchParams.get('contexto') ?? '').trim().toLowerCase();
	if (activarMfa && pedido && !CONTEXTO_AUTH.test(pedido))
		redirect(303, '/settings?entra=contexto#entra');
	const contexto = activarMfa ? pedido || null : undefined;
	const propia = probar ? await configPropia() : null;
	const config = probar
		? propia && (contexto === undefined ? propia : { ...propia, contextoAuth: contexto })
		: (await configActiva())?.config;
	if (!config) redirect(303, probar ? '/settings?entra=sin-config#entra' : '/sign-in');

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
			...(activarMfa ? { activarMfa: true, contexto } : {}),
			volverA: volverSeguro(url.searchParams.get('volverA'))
		}),
		{ path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 }
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
