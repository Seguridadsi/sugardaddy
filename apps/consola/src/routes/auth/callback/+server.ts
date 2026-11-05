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
		if (!url.search) redirect(303, '/entrar?salida=1');
		await auditar('anónimo', 'entrada denegada', {
			motivo: 'sin cookie de ida',
			agente: request.headers.get('user-agent')?.slice(0, 120)
		});
		redirect(303, '/entrar?error=caducado');
	}
	const { estado, nonce, verificador, volverA, probar } = JSON.parse(guardado);
	/* Una prueba desde Ajustes vuelve a Ajustes, con el motivo si sale mal. */
	function fuera(motivo: string): never {
		redirect(303, probar ? `/ajustes?entra=${motivo}#entra` : `/entrar?error=${motivo}`);
	}

	if (url.searchParams.get('error')) {
		await auditar('anónimo', 'entrada denegada', { motivo: url.searchParams.get('error') });
		fuera('rechazado');
	}
	if (url.searchParams.get('state') !== estado) {
		await auditar('anónimo', 'entrada denegada', { motivo: 'estado' });
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
		if (!locals.usuario || !puede(locals.usuario.roles, 'ajustes')) redirect(303, '/entrar');
		const config = await configPropia();
		if (!config) fuera('sin-config');
		let p;
		try {
			p = await canjear(config, { codigo, redirectUri, verificador, nonce });
		} catch (e) {
			console.error('[auth] canje de prueba fallido', e);
			fuera('canje');
		}
		const r = identidadPropia(p);
		if ('rechazo' in r) fuera(r.rechazo);
		else if (!r.roles.includes('admin')) fuera('sin-admin');
		else {
			await activarEntraPropio(locals.usuario.correo, r.correo);
			redirect(303, '/ajustes?entra=activado#entra');
		}
	}

	const activa = await configActiva();
	if (!activa) redirect(303, '/entrar');

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
		console.error('[auth] canje fallido', e);
		await auditar('anónimo', 'entrada denegada', { motivo: 'canje' });
		redirect(303, '/entrar?error=canje');
	}
	if ('rechazo' in r) {
		await auditar('anónimo', 'entrada denegada', { motivo: r.rechazo });
		redirect(303, `/entrar?error=${r.rechazo}`);
	}

	await abrir(cookies, r, url.protocol === 'https:');
	await auditar(r.correo, r.soporte ? `entrada de soporte de ${await operador()}` : 'entrada', {
		roles: r.roles
	});
	redirect(303, volverSeguro(volverA));
};
