import { fail, redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import {
	COOKIE_CAMBIO,
	cambiarClave,
	cambiarCorreo,
	cerrarRetoCambio,
	correoValido,
	MIN_CLAVE,
	pendientesAlEntrar,
	retoCambio
} from '$lib/server/auth/local';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

/*
 * El paso previo a entrar: cambiar la contraseña de un solo uso, poner el correo
 * de recuperación, o las dos cosas. Solo se pinta lo que le falta a ese usuario.
 */
export const load = async ({ url, cookies, locals }) => {
	if (locals.usuario) redirect(303, '/');
	/* Sin un reto de cambio válido no se pinta nada: de vuelta a la entrada. */
	const id = retoCambio(cookies.get(COOKIE_CAMBIO));
	const pendientes = id ? await pendientesAlEntrar(id) : null;
	if (!pendientes) {
		cookies.delete(COOKIE_CAMBIO, { path: '/sign-in' });
		redirect(303, '/sign-in');
	}
	return {
		volverA: url.searchParams.get('volverA') ?? '/',
		minimo: MIN_CLAVE,
		usuario: pendientes.usuario,
		pideClave: pendientes.clave,
		pideCorreo: pendientes.correo
	};
};

export const actions = {
	default: async ({ request, cookies, url }) => {
		const reto = cookies.get(COOKIE_CAMBIO);
		const id = retoCambio(reto);
		const pendientes = id ? await pendientesAlEntrar(id) : null;
		if (!id || !pendientes) {
			cookies.delete(COOKIE_CAMBIO, { path: '/sign-in' });
			return fail(400, { error: 'The change has expired. Sign in again.', correo: '' });
		}
		const f = await request.formData();
		const correo = String(f.get('correo') ?? '').trim();
		const nueva = String(f.get('clave') ?? '');
		const repetir = String(f.get('repetir') ?? '');
		const volverA = volverSeguro(String(f.get('volverA') ?? '/'));

		/* Todo se comprueba antes de escribir nada, para no dejar el cambio a medias. */
		if (pendientes.correo && !correoValido(correo))
			return fail(400, { error: 'Enter a valid email address, such as name@company.com.', correo });
		if (pendientes.clave) {
			if (nueva !== repetir) return fail(400, { error: 'The two passwords do not match.', correo });
			if (nueva.length < MIN_CLAVE)
				return fail(400, {
					error: `The password needs at least ${MIN_CLAVE} characters.`,
					correo
				});
		}

		let r = pendientes.correo ? await cambiarCorreo(correo, id, correo) : null;
		if (r && !r.ok) return fail(400, { error: r.error, correo });
		if (pendientes.clave) {
			r = await cambiarClave(id, nueva);
			if (!r.ok) return fail(400, { error: r.error, correo });
			await auditar(r.identidad.correo, 'local password changed (first sign-in)');
		}
		if (!r?.ok) return fail(400, { error: 'There was nothing to change. Sign in again.', correo });

		/* Hecho: se gasta el reto, se cierra la cookie y ya sí se entra. */
		cerrarRetoCambio(reto);
		cookies.delete(COOKIE_CAMBIO, { path: '/sign-in' });
		await abrir(cookies, r.identidad, url.protocol === 'https:');
		redirect(303, volverA);
	}
};
