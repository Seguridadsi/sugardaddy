import { error, json } from '@sveltejs/kit';
import { sinLlavePorIp } from '$lib/llave-por-ip';
import { puede } from '$lib/permisos';
import { codigoValido, opcionesRegistro } from '$lib/server/emergencia';

/* Registrar una llave: un administrador con su sesión, o quien tenga un código sacado en la máquina. */
export const POST = async ({ url, cookies, request, locals }) => {
	const porIp = sinLlavePorIp(url.hostname);
	if (porIp) error(400, porIp);
	const b = await request.json().catch(() => ({}));
	const nombre = String(b?.nombre ?? '')
		.trim()
		.slice(0, 60);
	if (nombre.length < 3) error(400, 'Give the key a name (e.g. "Safe YubiKey")');
	const admin = !!locals.usuario && puede(locals.usuario.roles, 'ajustes');
	const conCodigo = !admin && (await codigoValido(b?.codigo ?? null));
	if (!admin && !conCodigo)
		error(403, 'You must be an administrator or have a valid enrollment code');
	const quien = admin ? locals.usuario!.correo : 'emergency code';
	const r = await opcionesRegistro(url.hostname, nombre, quien, conCodigo ? b.codigo : null);
	cookies.set('sd_reto', r.reto, {
		path: '/emergency',
		httpOnly: true,
		sameSite: 'strict',
		secure: url.protocol === 'https:',
		maxAge: 300
	});
	return json(r.opciones);
};
