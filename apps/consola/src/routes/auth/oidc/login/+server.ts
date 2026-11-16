import { redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import {
	descubrir,
	generarEstadoOidc,
	generarVerificadorOidc,
	urlDeAutorizacionOidc
} from '@sugardaddy/entra/oidc';
import { exigir } from '$lib/server/auth/permisos';
import { COOKIE_OIDC_PROPIO, configOidc, oidcActivo } from '$lib/server/auth/oidc-propio';

/*
 * Ida al proveedor de identidad (OIDC). Con ?probar, un administrador ya
 * dentro prueba la configuración que acaba de guardar en Ajustes (aún
 * pendiente): si vuelve con el rol admin, se activa (oidc/callback).
 */
export const GET = async ({ url, cookies, locals }) => {
	const probar = url.searchParams.has('probar');
	if (probar) exigir(locals, 'ajustes');
	else if (locals.usuario) redirect(303, '/');
	const c = probar ? await configOidc() : await oidcActivo();
	if (!c) redirect(303, probar ? '/settings?tab=access&oidc=sin-config#oidc' : '/sign-in');

	let d;
	try {
		d = await descubrir(c.config.emisor);
	} catch (e) {
		console.error('[oidc] discovery failed', e);
		redirect(303, probar ? '/settings?tab=access&oidc=descubrimiento#oidc' : '/sign-in?error=idp');
	}
	const estado = generarEstadoOidc();
	const nonce = generarEstadoOidc();
	const verificador = generarVerificadorOidc();
	cookies.set(
		COOKIE_OIDC_PROPIO,
		JSON.stringify({
			estado,
			nonce,
			verificador,
			probar,
			volverA: volverSeguro(url.searchParams.get('volverA'))
		}),
		{ path: '/auth/oidc', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 }
	);
	redirect(
		303,
		await urlDeAutorizacionOidc(c.config, d, {
			redirectUri: `${url.origin}/auth/oidc/callback`,
			estado,
			nonce,
			verificador
		})
	);
};
