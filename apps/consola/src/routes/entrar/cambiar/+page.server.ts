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
		cookies.delete(COOKIE_CAMBIO, { path: '/entrar' });
		redirect(303, '/entrar');
	}
	return {
		volverA: url.searchParams.get('volverA') ?? '/',
		minimo: MIN_CLAVE,
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
			cookies.delete(COOKIE_CAMBIO, { path: '/entrar' });
			return fail(400, { error: 'El cambio ha caducado. Vuelve a entrar.', correo: '' });
		}
		const f = await request.formData();
		const correo = String(f.get('correo') ?? '').trim();
		const nueva = String(f.get('clave') ?? '');
		const repetir = String(f.get('repetir') ?? '');
		const volverA = volverSeguro(String(f.get('volverA') ?? '/'));

		/* Todo se comprueba antes de escribir nada, para no dejar el cambio a medias. */
		if (pendientes.correo && !correoValido(correo))
			return fail(400, { error: 'Pon un correo válido, del tipo nombre@empresa.com.', correo });
		if (pendientes.clave) {
			if (nueva !== repetir)
				return fail(400, { error: 'Las dos contraseñas no coinciden.', correo });
			if (nueva.length < MIN_CLAVE)
				return fail(400, {
					error: `La contraseña necesita al menos ${MIN_CLAVE} caracteres.`,
					correo
				});
		}

		let r = pendientes.correo ? await cambiarCorreo(correo, id, correo) : null;
		if (r && !r.ok) return fail(400, { error: r.error, correo });
		if (pendientes.clave) {
			r = await cambiarClave(id, nueva);
			if (!r.ok) return fail(400, { error: r.error, correo });
			await auditar(r.identidad.correo, 'contraseña local cambiada (primer acceso)');
		}
		if (!r?.ok) return fail(400, { error: 'No había nada que cambiar. Vuelve a entrar.', correo });

		/* Hecho: se gasta el reto, se cierra la cookie y ya sí se entra. */
		cerrarRetoCambio(reto);
		cookies.delete(COOKIE_CAMBIO, { path: '/entrar' });
		await abrir(cookies, r.identidad, url.protocol === 'https:');
		redirect(303, volverA);
	}
};
