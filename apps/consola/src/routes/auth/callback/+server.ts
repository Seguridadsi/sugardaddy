import { redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import { env } from '$env/dynamic/private';
import { COOKIE_OIDC, canjearCodigo, type PuertaSoporte } from '$lib/server/auth/entra';
import { soporte } from '$lib/server/soporte';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

export const GET = async ({ url, cookies, request }) => {
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
	const { estado, nonce, verificador, volverA } = JSON.parse(guardado);

	if (url.searchParams.get('error')) {
		await auditar('anónimo', 'entrada denegada', { motivo: url.searchParams.get('error') });
		redirect(303, '/entrar?error=rechazado');
	}
	if (url.searchParams.get('state') !== estado) {
		await auditar('anónimo', 'entrada denegada', { motivo: 'estado' });
		redirect(303, '/entrar?error=estado');
	}
	const codigo = url.searchParams.get('code');
	if (!codigo) redirect(303, '/entrar?error=caducado');

	/* La puerta de soporte solo existe mientras el cliente la tenga abierta. */
	const sop = await soporte();
	const puerta: PuertaSoporte =
		sop.estado === 'abierto' && sop.rol && env.ENTRA_GRUPO_SOPORTE
			? { grupo: env.ENTRA_GRUPO_SOPORTE, rol: sop.rol }
			: null;

	let r;
	try {
		r = await canjearCodigo(
			{ codigo, redirectUri: `${url.origin}/auth/callback`, verificador, nonce },
			puerta
		);
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
	await auditar(r.correo, r.soporte ? 'entrada de soporte de SeguridadSI' : 'entrada', {
		roles: r.roles
	});
	redirect(303, volverSeguro(volverA));
};
