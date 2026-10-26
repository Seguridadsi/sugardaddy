import { redirect } from '@sveltejs/kit';
import { urlDeCierre } from '@sugardaddy/entra';
import { config, configurado } from '$lib/server/auth/entra';
import { cerrar } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

/* Solo POST: que un enlace ajeno no pueda cerrarle la sesión a nadie. */
export const POST = async ({ url, cookies, locals }) => {
	if (locals.usuario) await auditar(locals.usuario.correo, 'salida');
	const oid = await cerrar(cookies);
	/*
	 * Solo una sesión federada (de Entra) se cierra también en Microsoft, para que
	 * el siguiente en este ordenador no entre de un clic. Las locales y las de
	 * emergencia no pasan por Microsoft: mandarlas allí sería un desvío sin sentido.
	 */
	const federada = !!oid && !oid.startsWith('local:') && !oid.startsWith('emergencia:');
	redirect(
		303,
		configurado() && federada ? urlDeCierre(config(), `${url.origin}/auth/callback`) : '/entrar'
	);
};
