import { fail, redirect } from '@sveltejs/kit';
import { loginLocalHabilitado, MIN_CLAVE } from '$lib/server/auth/local';
import { canjearCodigo, MINUTOS_CODIGO, pedirCodigo } from '$lib/server/auth/recuperar';
import { despuesDeLaClave } from '$lib/server/auth/segundo-factor';

/* La IP de quien pide: la que pone Caddy (ADDRESS_HEADER). null si no se sabe; comparten cupo. */
function ipDe(getClientAddress: () => string): string | null {
	try {
		return getClientAddress() || null;
	} catch {
		return null;
	}
}

/*
 * «¿Has olvidado la contraseña?»: primero se pide el código (por usuario), luego
 * se canjea con la contraseña nueva. La respuesta al pedirlo es siempre la
 * misma, exista o no el usuario (auth/recuperar.ts).
 */
export const load = ({ url, locals }) => {
	if (locals.usuario) redirect(303, '/');
	if (!loginLocalHabilitado()) redirect(303, '/sign-in');
	return {
		minimo: MIN_CLAVE,
		minutos: MINUTOS_CODIGO,
		yaTengo: url.searchParams.has('codigo')
	};
};

export const actions = {
	pedir: async ({ request, getClientAddress }) => {
		const usuario = String((await request.formData()).get('usuario') ?? '').trim();
		if (!usuario) return fail(400, { paso: 'pedir', usuario, error: 'Enter your username.' });
		await pedirCodigo(usuario, ipDe(getClientAddress));
		return { paso: 'codigo', usuario, enviado: true };
	},
	cambiar: async ({ request, cookies, getClientAddress }) => {
		const f = await request.formData();
		const usuario = String(f.get('usuario') ?? '').trim();
		const codigo = String(f.get('codigo') ?? '');
		const nueva = String(f.get('clave') ?? '');
		const repetir = String(f.get('repetir') ?? '');
		if (nueva !== repetir)
			return fail(400, { paso: 'codigo', usuario, error: 'The two passwords do not match.' });
		const r = await canjearCodigo(usuario, codigo, nueva, ipDe(getClientAddress));
		if (!r.ok) return fail(400, { paso: 'codigo', usuario, error: r.error });

		/*
		 * Recuperar la contraseña no salta el segundo factor: quien tenga el correo
		 * pero no el móvil (o la passkey) se queda aquí. Si aún le falta el correo
		 * de recuperación, se le pide después (segundo-factor.ts).
		 */
		redirect(303, await despuesDeLaClave(cookies, r.id, r.identidad, '/'));
	}
};
