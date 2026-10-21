import { error, json } from '@sveltejs/kit';
import { puede } from '$lib/permisos';
import { codigoValido, opcionesRegistro } from '$lib/server/emergencia';

/* Registrar una llave: un administrador con su sesión, o quien tenga un código sacado en la máquina. */
export const POST = async ({ url, cookies, request, locals }) => {
	const b = await request.json().catch(() => ({}));
	const nombre = String(b?.nombre ?? '')
		.trim()
		.slice(0, 60);
	if (nombre.length < 3)
		error(400, 'Pon un nombre a la llave (p. ej. «YubiKey de la caja fuerte»)');
	const admin = !!locals.usuario && puede(locals.usuario.roles, 'ajustes');
	const conCodigo = !admin && (await codigoValido(b?.codigo ?? null));
	if (!admin && !conCodigo) error(403, 'Hace falta ser administrador o un código de alta válido');
	const quien = admin ? locals.usuario!.correo : 'código de emergencia';
	const r = await opcionesRegistro(url.hostname, nombre, quien);
	cookies.set('sd_reto', r.reto, {
		path: '/emergencia',
		httpOnly: true,
		sameSite: 'strict',
		secure: url.protocol === 'https:',
		maxAge: 300
	});
	cookies.set('sd_alta_codigo', conCodigo ? '1' : '0', {
		path: '/emergencia',
		httpOnly: true,
		sameSite: 'strict',
		secure: url.protocol === 'https:',
		maxAge: 300
	});
	return json(r.opciones);
};
