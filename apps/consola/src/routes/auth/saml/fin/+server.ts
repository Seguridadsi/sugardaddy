import { timingSafeEqual } from 'node:crypto';
import { redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import { puede } from '$lib/permisos';
import {
	COOKIE_SAML_PROPIO,
	activarSaml,
	gastarResultado,
	samlActivo
} from '$lib/server/auth/saml-propio';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

const iguales = (a: string, b: string) =>
	a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/*
 * Tras el ACS: el navegador llega aquí con un GET de primer nivel, que sí trae
 * las cookies (la de la ida y, en una prueba, la sesión del administrador). La
 * ficha es de un solo uso y su RelayState tiene que ser el de la cookie: así
 * una respuesta buena de otra persona no abre sesión en este navegador.
 */
export const GET = async ({ url, cookies, locals }) => {
	const guardado = cookies.get(COOKIE_SAML_PROPIO);
	cookies.delete(COOKIE_SAML_PROPIO, { path: '/auth/saml', secure: true });
	const r = gastarResultado(url.searchParams.get('ficha') ?? '');
	let ida: { relay?: string; volverA?: string } = {};
	try {
		ida = JSON.parse(guardado ?? '{}');
	} catch {
		ida = {};
	}
	if (!r || typeof ida.relay !== 'string' || !iguales(ida.relay, r.relay)) {
		await auditar('anonymous', 'sign-in denied', { via: 'saml', motivo: 'browser mismatch' });
		redirect(303, r?.probar ? '/settings?tab=access&saml=estado#saml' : '/sign-in?error=caducado');
	}

	/* La prueba: la hace un administrador que ya está dentro; su sesión no cambia. */
	if (r.probar) {
		if (!locals.usuario || !puede(locals.usuario.roles, 'ajustes')) redirect(303, '/sign-in');
		await activarSaml(locals.usuario.correo, r.identidad.correo);
		redirect(303, '/settings?tab=access&saml=activado#saml');
	}

	const c = await samlActivo();
	if (!c) redirect(303, '/sign-in?error=idp');
	await abrir(cookies, r.identidad, c.guardado.exigirMfa ? 'idp' : null);
	await auditar(r.identidad.correo, 'SAML sign-in', {
		roles: r.identidad.roles,
		entidad: c.guardado.entidad
	});
	redirect(303, volverSeguro(ida.volverA ?? '/'));
};
