import { Freno, claveIp } from '$lib/server/auth/freno';
import { fail, redirect } from '@sveltejs/kit';
import { volverSeguro } from '@sugardaddy/entra';
import { descubrir } from '@sugardaddy/entra/oidc';
import { configActiva } from '$lib/server/auth/entra-propio';
import { oidcActivo } from '$lib/server/auth/oidc-propio';
import { samlActivo } from '$lib/server/auth/saml-propio';
import { loginLocalHabilitado, verificar } from '$lib/server/auth/local';
import { despuesDeLaClave } from '$lib/server/auth/segundo-factor';
import { INACTIVIDAD_MS, MAXIMO_MS } from '$lib/server/auth/sesion';
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
	sin_oid: 'The Microsoft token does not identify your account.',
	sin_mfa:
		'This console requires multi-factor authentication, and Microsoft did not report it for this sign-in. Ask your administrator to require MFA for the Sugardaddy application with Conditional Access (an authentication context set in Settings).',
	desactivada:
		'Your account is disabled because it was not used for a long time, or an administrator disabled it. Ask an administrator of this console to enable it in Settings → Access review.',
	soporte_cerrado:
		'Support access to this console is not open. The customer opens it from Settings when you request it.',
	soporte_otro:
		'This support account cannot sign in: it must be the person who requested access, invited from their own organization.',
	idp: 'Your identity provider cannot be reached right now. Try again, or use another way to sign in.',
	idp_rechazado: 'Your identity provider did not allow the sign-in.',
	idp_canje: 'Your identity could not be verified with your identity provider. Try again.',
	idp_sin_oid: 'Your identity provider did not identify your account.',
	idp_sin_mfa:
		'This console requires multi-factor authentication, and your identity provider did not report it for this sign-in. Ask your administrator to require MFA for the Sugardaddy application in your identity provider.'
};

/* Tras salir de una sesión de OIDC: el enlace para salir también del proveedor (si publica uno). */
async function salidaDelProveedor() {
	const c = await oidcActivo();
	if (!c) return null;
	try {
		const d = await descubrir(c.config.emisor);
		if (!d.end_session_endpoint) return null;
		const u = new URL(d.end_session_endpoint);
		u.searchParams.set('client_id', c.config.clientId);
		return { url: u.toString(), nombre: c.guardado.nombre };
	} catch {
		return null;
	}
}

export const load = async ({ url, locals }) => {
	if (locals.usuario) redirect(303, '/');
	const oidc = await oidcActivo();
	const saml = await samlActivo();
	return {
		configurado: !!(await configActiva()),
		oidc: oidc ? { nombre: oidc.guardado.nombre } : null,
		saml: saml ? { nombre: saml.guardado.nombre } : null,
		/* Tras salir de una sesión de SAML: la del proveedor sigue abierta (sin cierre único). */
		salidaSaml: url.searchParams.get('salida') === 'saml' && saml ? saml.guardado.nombre : null,
		salidaProveedor: url.searchParams.get('salida') === 'oidc' ? await salidaDelProveedor() : null,
		local: loginLocalHabilitado(),
		volverA: url.searchParams.get('volverA') ?? '/',
		error: MENSAJES[url.searchParams.get('error') ?? ''] ?? null,
		salida: url.searchParams.has('salida'),
		/* Venía con una sesión que ya no vale (hooks.server.ts): se dice cuánto dura una. */
		caducada: url.searchParams.has('caducada'),
		minutosInactividad: INACTIVIDAD_MS / 60_000,
		horasMaximo: MAXIMO_MS / 3_600_000
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
	local: async ({ request, cookies, locals, getClientAddress }) => {
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

		/*
		 * La sesión no se abre todavía: antes, el segundo factor (o su alta, si se
		 * exige y no tiene ninguno) y lo que le falte (contraseña de un solo uso,
		 * correo de recuperación) en /sign-in/change. Ver segundo-factor.ts.
		 */
		redirect(303, await despuesDeLaClave(cookies, r.id, r.identidad, volverA));
	}
};
