import { fail, redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import {
	COOKIE_CAMBIO,
	cambiarClave,
	cerrarRetoCambio,
	MIN_CLAVE,
	retoCambio
} from '$lib/server/auth/local';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

export const load = ({ url, cookies, locals }) => {
	if (locals.usuario) redirect(303, '/');
	/* Sin un reto de cambio válido no se pinta nada: de vuelta a la entrada. */
	if (!retoCambio(cookies.get(COOKIE_CAMBIO))) {
		cookies.delete(COOKIE_CAMBIO, { path: '/entrar' });
		redirect(303, '/entrar');
	}
	return { volverA: url.searchParams.get('volverA') ?? '/', minimo: MIN_CLAVE };
};

export const actions = {
	default: async ({ request, cookies, url }) => {
		const reto = cookies.get(COOKIE_CAMBIO);
		const id = retoCambio(reto);
		if (!id) {
			cookies.delete(COOKIE_CAMBIO, { path: '/entrar' });
			return fail(400, { error: 'El cambio ha caducado. Vuelve a entrar.' });
		}
		const f = await request.formData();
		const nueva = String(f.get('clave') ?? '');
		const repetir = String(f.get('repetir') ?? '');
		const volverA = volverSeguro(String(f.get('volverA') ?? '/'));
		if (nueva !== repetir) return fail(400, { error: 'Las dos contraseñas no coinciden.' });

		const r = await cambiarClave(id, nueva);
		if (!r.ok) return fail(400, { error: r.error });

		/* Hecho el cambio: se gasta el reto, se cierra la cookie y ya sí se entra. */
		cerrarRetoCambio(reto);
		cookies.delete(COOKIE_CAMBIO, { path: '/entrar' });
		await abrir(cookies, r.identidad, url.protocol === 'https:');
		await auditar(r.identidad.correo, 'contraseña local cambiada (primer acceso)');
		redirect(303, volverA);
	}
};
