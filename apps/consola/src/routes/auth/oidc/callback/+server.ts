import { redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import { canjearOidc, descubrir } from '@sugardaddy/entra/oidc';
import { puede } from '$lib/permisos';
import {
	COOKIE_OIDC_PROPIO,
	activarOidc,
	configOidc,
	identidadOidc,
	oidcActivo
} from '$lib/server/auth/oidc-propio';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

/* Vuelta del proveedor de identidad (OIDC): mismo recorrido que auth/callback con Microsoft. */
export const GET = async ({ url, cookies, locals }) => {
	const guardado = cookies.get(COOKIE_OIDC_PROPIO);
	cookies.delete(COOKIE_OIDC_PROPIO, { path: '/auth/oidc', secure: true });
	let ida: { estado: string; nonce: string; verificador: string; volverA: string; probar: boolean };
	try {
		ida = JSON.parse(guardado ?? '');
	} catch {
		await auditar('anonymous', 'sign-in denied', { via: 'oidc', motivo: 'no outbound cookie' });
		redirect(303, '/sign-in?error=caducado');
	}
	const { estado, nonce, verificador, volverA, probar } = ida;
	/* Una prueba desde Ajustes vuelve a Ajustes, con el motivo si sale mal. */
	function fuera(motivo: string): never {
		redirect(303, probar ? `/settings?tab=access&oidc=${motivo}#oidc` : `/sign-in?error=${motivo}`);
	}

	if (url.searchParams.get('error')) {
		await auditar('anonymous', 'sign-in denied', {
			via: 'oidc',
			motivo: url.searchParams.get('error')?.slice(0, 60)
		});
		fuera(probar ? 'rechazado' : 'idp_rechazado');
	}
	if (url.searchParams.get('state') !== estado) {
		await auditar('anonymous', 'sign-in denied', { via: 'oidc', motivo: 'estado' });
		fuera('estado');
	}
	const codigo = url.searchParams.get('code');
	if (!codigo) fuera('caducado');

	if (probar && (!locals.usuario || !puede(locals.usuario.roles, 'ajustes')))
		redirect(303, '/sign-in');
	const c = probar ? await configOidc() : await oidcActivo();
	if (!c) fuera(probar ? 'sin-config' : 'idp');

	let p;
	try {
		const d = await descubrir(c.config.emisor);
		p = await canjearOidc(c.config, d, {
			codigo,
			redirectUri: `${url.origin}/auth/oidc/callback`,
			verificador,
			nonce
		});
	} catch (e) {
		console.error('[oidc] exchange failed', e);
		await auditar('anonymous', 'sign-in denied', { via: 'oidc', motivo: 'canje' });
		fuera(probar ? 'canje' : 'idp_canje');
	}
	const r = identidadOidc(p, c.guardado);
	if ('rechazo' in r) {
		await auditar('anonymous', 'sign-in denied', {
			via: 'oidc',
			motivo: r.rechazo,
			sub: typeof p.sub === 'string' ? p.sub.slice(0, 80) : null
		});
		fuera(r.rechazo === 'sin_rol' || r.rechazo === 'sin_correo' ? r.rechazo : `idp_${r.rechazo}`);
	}

	/* La prueba: la hace un administrador que ya está dentro; su sesión no cambia. */
	if (probar) {
		if (!r.roles.includes('admin')) fuera('sin-admin');
		await activarOidc(locals.usuario!.correo, r.correo);
		redirect(303, '/settings?tab=access&oidc=activado#oidc');
	}

	await abrir(cookies, r, c.guardado.exigirMfa ? 'idp' : null);
	await auditar(r.correo, 'OIDC sign-in', { roles: r.roles, emisor: c.guardado.emisor });
	redirect(303, volverSeguro(volverA));
};
