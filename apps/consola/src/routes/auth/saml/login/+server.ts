import { redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import { exigir } from '$lib/server/auth/permisos';
import {
	COOKIE_SAML_PROPIO,
	cacheSaml,
	configSaml,
	nuevaIda,
	samlActivo
} from '$lib/server/auth/saml-propio';
import { crearSaml, urlDeIda } from '$lib/server/auth/saml';

/*
 * Ida al proveedor de identidad (SAML 2.0, HTTP-Redirect firmado). Con ?probar,
 * un administrador ya dentro prueba la configuración que acaba de guardar en
 * Ajustes (aún pendiente): si vuelve con el rol admin, se activa (saml/fin).
 */
export const GET = async ({ url, cookies, locals }) => {
	const probar = url.searchParams.has('probar');
	if (probar) exigir(locals, 'ajustes');
	else if (locals.usuario) redirect(303, '/');
	const c = probar ? await configSaml() : await samlActivo();
	if (!c) redirect(303, probar ? '/settings?tab=access&saml=sin-config#saml' : '/sign-in');

	const relay = nuevaIda(probar);
	let destino: string | null = null;
	if (relay)
		try {
			destino = await urlDeIda(crearSaml(c.config, cacheSaml()), relay);
		} catch (e) {
			console.error('[saml] AuthnRequest failed', e);
		}
	if (!relay || !destino)
		redirect(303, probar ? '/settings?tab=access&saml=ida#saml' : '/sign-in?error=idp');
	cookies.set(
		COOKIE_SAML_PROPIO,
		JSON.stringify({ relay, volverA: volverSeguro(url.searchParams.get('volverA')) }),
		{ path: '/auth/saml', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 }
	);
	redirect(303, destino);
};
