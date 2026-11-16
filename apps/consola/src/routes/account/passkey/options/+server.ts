import { error, json } from '@sveltejs/kit';
import { sinLlavePorIp } from '$lib/llave-por-ip';
import { pendientesAlEntrar } from '$lib/server/auth/local';
import { opcionesAltaPasskey } from '$lib/server/auth/segundo-factor';
import { guardarRetoCuenta, COOKIE_RETO_CUENTA, idLocalDe } from '$lib/server/auth/reto-cuenta';

/* Añadir una passkey desde Mi cuenta: las opciones de registro. */
export const POST = async ({ url, cookies, locals }) => {
	const id = idLocalDe(locals);
	if (!id) error(403, 'Only users with local sign-in can add a passkey.');
	const porIp = sinLlavePorIp(url.hostname);
	if (porIp) error(400, porIp);
	const usuario = (await pendientesAlEntrar(id))?.usuario ?? 'user';
	const o = await opcionesAltaPasskey(url.hostname, id, usuario);
	cookies.set(COOKIE_RETO_CUENTA, guardarRetoCuenta({ reto: o.challenge, id }), {
		path: '/account',
		httpOnly: true,
		sameSite: 'strict',
		secure: true,
		maxAge: 300
	});
	return json(o);
};
