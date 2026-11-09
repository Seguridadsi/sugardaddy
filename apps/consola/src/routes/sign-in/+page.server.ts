import { Freno, claveIp } from '$lib/server/auth/freno';
import { fail, redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import { configActiva } from '$lib/server/auth/entra-propio';
import {
	COOKIE_CAMBIO,
	abrirRetoCambio,
	loginLocalHabilitado,
	verificar
} from '$lib/server/auth/local';
import { abrir } from '$lib/server/auth/sesion';
import { auditar } from '$lib/server/consultas';

const MENSAJES: Record<string, string> = {
	caducado: 'Sign-in took too long. Try again.',
	rechazado: 'Microsoft did not allow the sign-in.',
	estado: 'The Microsoft response does not match this sign-in attempt. Try again.',
	canje: 'Your identity could not be verified. Try again.',
	sin_grupo:
		'Your account does not belong to this customer. Ask your organization administrator for access.',
	sin_rol: 'Your account has no role in Sugardaddy. Ask your organization administrator for one.',
	demasiados_grupos:
		'Your account is in too many groups to check access. Contact your support provider.',
	sin_correo: 'Your account has no email address.',
	sin_oid: 'The Microsoft token does not identify your account.'
};

export const load = async ({ url, locals }) => {
	if (locals.usuario) redirect(303, '/');
	return {
		configurado: !!(await configActiva()),
		local: loginLocalHabilitado(),
		volverA: url.searchParams.get('volverA') ?? '/',
		error: MENSAJES[url.searchParams.get('error') ?? ''] ?? null,
		salida: url.searchParams.has('salida')
	};
};

/* Intentos de entrada por IP: veinte cada cuarto de hora. */
const ENTRADAS_POR_IP = new Freno(20, 15 * 60_000);

function ipDe(getClientAddress: () => string): string | null {
	try {
		return getClientAddress() || null;
	} catch {
		return null;
	}
}

export const actions = {
	/* Entrada con usuario y contraseña del nodo (login local). */
	local: async ({ request, cookies, url, locals, getClientAddress }) => {
		if (locals.usuario) redirect(303, '/');
		if (!loginLocalHabilitado())
			return fail(403, {
				error: 'This node does not support sign-in with a username and password.',
				usuario: ''
			});
		const f = await request.formData();
		const usuario = String(f.get('usuario') ?? '');
		const clave = String(f.get('clave') ?? '');
		const volverA = volverSeguro(String(f.get('volverA') ?? '/'));

		/* Por IP, aparte del bloqueo de cada usuario: probar muchos usuarios desde una dirección se para aquí. */
		if (!ENTRADAS_POR_IP.pasa(claveIp(ipDe(getClientAddress)))) {
			await auditar('anonymous', 'local sign-in denied', {
				usuario: usuario.trim().toLowerCase().slice(0, 64),
				motivo: 'throttled by address'
			});
			return fail(429, { error: 'Too many attempts. Wait a few minutes and try again.', usuario });
		}
		const r = await verificar(usuario, clave);
		if (!r.ok) {
			/* El motivo real (credenciales/bloqueado) va a la auditoría, pero NO al
			 * mensaje: si solo un usuario existente pudiera ver «bloqueado», eso
			 * delataría qué usuarios existen. De cara a quien entra, todo es lo mismo. */
			await auditar('anonymous', 'local sign-in denied', {
				usuario: usuario.trim().toLowerCase().slice(0, 64),
				motivo: r.motivo
			});
			return fail(401, { error: 'Incorrect username or password.', usuario });
		}

		/* Contraseña de un solo uso o sin correo de recuperación: no se abre sesión
		 * hasta que lo arregle en /sign-in/change. */
		if (r.debeCambiar || r.pideCorreo) {
			cookies.set(COOKIE_CAMBIO, abrirRetoCambio(r.id), {
				path: '/sign-in',
				httpOnly: true,
				sameSite: 'lax',
				secure: url.protocol === 'https:',
				maxAge: 600
			});
			redirect(303, `/sign-in/change?volverA=${encodeURIComponent(volverA)}`);
		}

		await abrir(cookies, r.identidad, url.protocol === 'https:');
		await auditar(r.identidad.correo, 'local sign-in', { roles: r.identidad.roles });
		redirect(303, volverA);
	}
};
