import { redirect } from '@sveltejs/kit';
import { configurado } from '$lib/server/auth/entra';

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
		volverA: url.searchParams.get('volverA') ?? '/',
		error: MENSAJES[url.searchParams.get('error') ?? ''] ?? null,
		salida: url.searchParams.has('salida')
	};
};
