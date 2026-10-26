import { fail, redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import { configurado } from '$lib/server/auth/entra';
import {
	COOKIE_CAMBIO,
	abrirRetoCambio,
	loginLocalHabilitado,
	verificar
} from '$lib/server/auth/local';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

const MENSAJES: Record<string, string> = {
	caducado: 'La entrada ha tardado demasiado. Vuelve a intentarlo.',
	rechazado: 'Microsoft no ha dejado entrar.',
	estado: 'La respuesta de Microsoft no corresponde a esta entrada. Vuelve a intentarlo.',
	canje: 'No se ha podido comprobar tu identidad. Vuelve a intentarlo.',
	sin_grupo:
		'Tu cuenta no pertenece a este cliente. Pide acceso al administrador de tu organización.',
	sin_rol:
		'Tu cuenta no tiene ningún rol en Sugardaddy. Pide uno al administrador de tu organización.',
	demasiados_grupos:
		'Tu cuenta está en demasiados grupos para comprobar el acceso. Avisa a SeguridadSI.',
	sin_correo: 'Tu cuenta no tiene dirección de correo.',
	sin_oid: 'El token de Microsoft no identifica tu cuenta.'
};

export const load = ({ url, locals }) => {
	if (locals.usuario) redirect(303, '/');
	return {
		configurado: configurado(),
		local: loginLocalHabilitado(),
		volverA: url.searchParams.get('volverA') ?? '/',
		error: MENSAJES[url.searchParams.get('error') ?? ''] ?? null,
		salida: url.searchParams.has('salida')
	};
};

export const actions = {
	/* Entrada con usuario y contraseña del nodo (login local). */
	local: async ({ request, cookies, url, locals }) => {
		if (locals.usuario) redirect(303, '/');
		if (!loginLocalHabilitado())
			return fail(403, {
				error: 'Este nodo no admite entrada con usuario y contraseña.',
				usuario: ''
			});
		const f = await request.formData();
		const usuario = String(f.get('usuario') ?? '');
		const clave = String(f.get('clave') ?? '');
		const volverA = volverSeguro(String(f.get('volverA') ?? '/'));

		const r = await verificar(usuario, clave);
		if (!r.ok) {
			/* El motivo real (credenciales/bloqueado) va a la auditoría, pero NO al
			 * mensaje: si solo un usuario existente pudiera ver «bloqueado», eso
			 * delataría qué usuarios existen. De cara a quien entra, todo es lo mismo. */
			await auditar('anónimo', 'entrada local denegada', {
				usuario: usuario.trim().toLowerCase().slice(0, 64),
				motivo: r.motivo
			});
			return fail(401, { error: 'Usuario o contraseña incorrectos.', usuario });
		}

		/* Contraseña de un solo uso: no se abre sesión hasta que la cambie. */
		if (r.debeCambiar) {
			cookies.set(COOKIE_CAMBIO, abrirRetoCambio(r.id), {
				path: '/entrar',
				httpOnly: true,
				sameSite: 'lax',
				secure: url.protocol === 'https:',
				maxAge: 600
			});
			redirect(303, `/entrar/cambiar?volverA=${encodeURIComponent(volverA)}`);
		}

		await abrir(cookies, r.identidad, url.protocol === 'https:');
		await auditar(r.identidad.correo, 'entrada local', { roles: r.identidad.roles });
		redirect(303, volverA);
	}
};
