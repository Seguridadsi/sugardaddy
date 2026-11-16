import { error, json } from '@sveltejs/kit';
import {
	altaEnPasoPasskey,
	cerrarPaso,
	despuesDelFactor,
	leerPaso,
	verificarPasskey
} from '$lib/server/auth/segundo-factor';

/*
 * La respuesta del navegador. Al entrar, si vale, sigue la entrada y dice adónde
 * ir; en el alta, guarda la passkey y devuelve los códigos de recuperación.
 */
export const POST = async ({ url, cookies, request }) => {
	const p = leerPaso(cookies);
	if (!p) error(401, 'Sign-in has expired. Sign in again.');
	const cuerpo = (await request.json().catch(() => null)) as {
		respuesta?: unknown;
		nombre?: unknown;
	} | null;
	if (!cuerpo?.respuesta) error(400, 'Missing passkey response.');
	if (p.modo === 'alta') {
		const r = await altaEnPasoPasskey(
			p,
			cuerpo.respuesta as never,
			url.origin,
			url.hostname,
			typeof cuerpo.nombre === 'string' ? cuerpo.nombre : ''
		);
		if (!r.ok) error(400, r.error);
		return json({ codigos: r.codigos });
	}
	const r = await verificarPasskey(cookies, p, cuerpo.respuesta as never, url.origin, url.hostname);
	if (!r.ok) error(r.fin ? 401 : 400, r.error);
	cerrarPaso(cookies);
	return json({
		ir: await despuesDelFactor(cookies, p.id, p.identidad, p.volverA, r.factor)
	});
};
