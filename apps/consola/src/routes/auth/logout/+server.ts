import { redirect } from '@sveltejs/kit';
import { urlDeCierre } from '@sugardaddy/entra';
import { config, configurado } from '$lib/server/auth/entra';
import { cerrar } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

/* Solo POST: que un enlace ajeno no pueda cerrarle la sesión a nadie. */
export const POST = async ({ url, cookies, locals }) => {
	if (locals.usuario) await auditar(locals.usuario.correo, 'salida');
	await cerrar(cookies);
	/* Se cierra también en Microsoft, para que el siguiente en este ordenador no entre de un clic. */
	redirect(303, configurado() ? urlDeCierre(config(), `${url.origin}/auth/callback`) : '/entrar');
};
