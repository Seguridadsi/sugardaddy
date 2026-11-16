import { error, json } from '@sveltejs/kit';
import { altaPasskey, factores, nuevosCodigos } from '$lib/server/auth/segundo-factor';
import { COOKIE_RETO_CUENTA, idLocalDe, tomarRetoCuenta } from '$lib/server/auth/reto-cuenta';

/* La respuesta del navegador: guarda la passkey. La primera trae sus códigos de recuperación. */
export const POST = async ({ url, cookies, locals, request }) => {
	const id = idLocalDe(locals);
	if (!id) error(403, 'Only users with local sign-in can add a passkey.');
	const r = tomarRetoCuenta(cookies.get(COOKIE_RETO_CUENTA));
	cookies.delete(COOKIE_RETO_CUENTA, { path: '/account', secure: true });
	if (!r || r.id !== id) error(400, 'The request has expired. Try again.');
	const cuerpo = (await request.json().catch(() => null)) as {
		respuesta?: unknown;
		nombre?: unknown;
	} | null;
	if (!cuerpo?.respuesta) error(400, 'Missing passkey response.');
	const primero = (await factores(id)).length === 0;
	const a = await altaPasskey(
		locals.usuario!.correo,
		id,
		r.reto,
		cuerpo.respuesta as never,
		url.origin,
		url.hostname,
		typeof cuerpo.nombre === 'string' ? cuerpo.nombre : ''
	);
	if (!a.ok) error(400, a.error);
	return json({ codigos: primero ? await nuevosCodigos(locals.usuario!.correo, id) : null });
};
