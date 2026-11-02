import { fail, redirect } from '@sveltejs/kit';
import {
	COOKIE_CAMBIO,
	abrirRetoCambio,
	loginLocalHabilitado,
	MIN_CLAVE,
	pendientesAlEntrar
} from '$lib/server/auth/local';
import { canjearCodigo, MINUTOS_CODIGO, pedirCodigo } from '$lib/server/auth/recuperar';
import { abrir } from '$lib/server/auth/sesion';

/*
 * «¿Has olvidado la contraseña?»: primero se pide el código (por usuario), luego
 * se canjea con la contraseña nueva. La respuesta al pedirlo es siempre la
 * misma, exista o no el usuario (auth/recuperar.ts).
 */
export const load = ({ url, locals }) => {
	if (locals.usuario) redirect(303, '/');
	if (!loginLocalHabilitado()) redirect(303, '/entrar');
	return {
		minimo: MIN_CLAVE,
		minutos: MINUTOS_CODIGO,
		yaTengo: url.searchParams.has('codigo')
	};
};

export const actions = {
	pedir: async ({ request }) => {
		const usuario = String((await request.formData()).get('usuario') ?? '').trim();
		if (!usuario) return fail(400, { paso: 'pedir', usuario, error: 'Escribe tu usuario.' });
		await pedirCodigo(usuario);
		return { paso: 'codigo', usuario, enviado: true };
	},
	cambiar: async ({ request, cookies, url }) => {
		const f = await request.formData();
		const usuario = String(f.get('usuario') ?? '').trim();
		const codigo = String(f.get('codigo') ?? '');
		const nueva = String(f.get('clave') ?? '');
		const repetir = String(f.get('repetir') ?? '');
		if (nueva !== repetir)
			return fail(400, { paso: 'codigo', usuario, error: 'Las dos contraseñas no coinciden.' });
		const r = await canjearCodigo(usuario, codigo, nueva);
		if (!r.ok) return fail(400, { paso: 'codigo', usuario, error: r.error });

		/* Si aún le falta el correo de recuperación, se le pide antes de entrar. */
		if ((await pendientesAlEntrar(r.id))?.correo) {
			cookies.set(COOKIE_CAMBIO, abrirRetoCambio(r.id), {
				path: '/entrar',
				httpOnly: true,
				sameSite: 'lax',
				secure: url.protocol === 'https:',
				maxAge: 600
			});
			redirect(303, '/entrar/cambiar');
		}
		await abrir(cookies, r.identidad, url.protocol === 'https:');
		redirect(303, '/');
	}
};
