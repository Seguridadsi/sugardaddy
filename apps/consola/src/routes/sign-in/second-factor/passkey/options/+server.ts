import { error, json } from '@sveltejs/kit';
import { sinLlavePorIp } from '$lib/llave-por-ip';
import { leerPaso, opcionesPasoPasskey } from '$lib/server/auth/segundo-factor';

/* Las opciones de WebAuthn del paso en curso: entrar con una passkey o darla de alta. */
export const POST = async ({ url, cookies }) => {
	const p = leerPaso(cookies);
	if (!p) error(401, 'Sign-in has expired. Sign in again.');
	const porIp = sinLlavePorIp(url.hostname);
	if (porIp) error(400, porIp);
	const o = await opcionesPasoPasskey(p, url.hostname);
	if (!o) error(404, 'You have no passkey registered.');
	return json(o);
};
