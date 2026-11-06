import { redirect } from '@sveltejs/kit';
import { canjear, volverSeguro } from '@sugardaddy/entra';
import { env } from '$env/dynamic/private';
import { puede } from '$lib/permisos';
import { COOKIE_OIDC, identidadPropia, type PuertaSoporte } from '$lib/server/auth/entra';
import {
	activarEntraPropio,
	canjearCodigo,
	configActiva,
	configPropia
} from '$lib/server/auth/entra-propio';
import { soporte } from '$lib/server/soporte';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';
import { operador } from '$lib/server/operador';

export const GET = async ({ url, cookies, request, locals }) => {
	const guardado = cookies.get(COOKIE_OIDC);
	cookies.delete(COOKIE_OIDC, { path: '/' });
	if (!guardado) {
		if (!url.search) redirect(303, '/sign-in?salida=1');
		await auditar('anonymous', 'sign-in denied', {
			motivo: 'no outbound cookie',
			agente: request.headers.get('user-agent')?.slice(0, 120)
		});
		redirect(303, '/sign-in?error=caducado');
	}
	const { estado, nonce, verificador, volverA, probar } = JSON.parse(guardado);
	/* Una prueba desde Ajustes vuelve a Ajustes, con el motivo si sale mal. */
	function fuera(motivo: string): never {
		redirect(303, probar ? `/settings?entra=${motivo}#entra` : `/sign-in?error=${motivo}`);
	}

	if (url.searchParams.get('error')) {
		await auditar('anonymous', 'sign-in denied', { motivo: url.searchParams.get('error') });
		fuera('rechazado');
	}
	if (url.searchParams.get('state') !== estado) {
		await auditar('anonymous', 'sign-in denied', { motivo: 'estado' });
		fuera('estado');
	}
	const codigo = url.searchParams.get('code');
	if (!codigo) fuera('caducado');
	const redirectUri = `${url.origin}/auth/callback`;

	/*
	 * La prueba del Entra propio: la hace un administrador que ya está dentro, y
	 * solo se activa si Microsoft devuelve a alguien con el rol admin. Su sesión
	 * no cambia.
	 */
	if (probar) {
		if (!locals.usuario || !puede(locals.usuario.roles, 'ajustes')) redirect(303, '/sign-in');
		const config = await configPropia();
		if (!config) fuera('sin-config');
		let p;
		try {
			p = await canjear(config, { codigo, redirectUri, verificador, nonce });
		} catch (e) {
			console.error('[auth] test exchange failed', e);
			fuera('canje');
		}
		const r = identidadPropia(p);
		if ('rechazo' in r) fuera(r.rechazo);
		else if (!r.roles.includes('admin')) fuera('sin-admin');
		else {
			await activarEntraPropio(locals.usuario.correo, r.correo);
			redirect(303, '/settings?entra=activado#entra');
		}
	}

	const activa = await configActiva();
	if (!activa) redirect(303, '/sign-in');

	/* La puerta de soporte solo existe mientras el cliente la tenga abierta. */
	const sop = await soporte();
	const puerta: PuertaSoporte =
		sop.estado === 'abierto' && sop.rol && env.ENTRA_GRUPO_SOPORTE
			? { grupo: env.ENTRA_GRUPO_SOPORTE, rol: sop.rol }
			: null;

	let r;
	try {
		r = await canjearCodigo(activa, { codigo, redirectUri, verificador, nonce }, puerta);
	} catch (e) {
		console.error('[auth] exchange failed', e);
		await auditar('anonymous', 'sign-in denied', { motivo: 'canje' });
		redirect(303, '/sign-in?error=canje');
	}
	if ('rechazo' in r) {
		await auditar('anonymous', 'sign-in denied', { motivo: r.rechazo });
		redirect(303, `/sign-in?error=${r.rechazo}`);
	}

	await abrir(cookies, r, url.protocol === 'https:');
	await auditar(r.correo, r.soporte ? `support sign-in by ${await operador()}` : 'sign-in', {
		roles: r.roles
	});
	redirect(303, volverSeguro(volverA));
};
