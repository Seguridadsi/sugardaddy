import { fail, redirect } from '@sveltejs/kit';
import {
	MIN_CLAVE,
	cambiarClavePropia,
	cambiarCorreo,
	claveCorrecta,
	cambiarNombrePropio,
	correoValido,
	loginLocalHabilitado,
	pendientesAlEntrar
} from '$lib/server/auth/local';
import { cambiarCorreoSesiones, renombrarSesiones, sesionActual } from '$lib/server/auth/sesion';
import { zonaValida } from '$lib/fechas';
import { guardarZona } from '$lib/server/zona-horaria';
import { sinLlavePorIp } from '$lib/llave-por-ip';
import { qrDataUri } from '$lib/server/qr';
import { generarSecreto, secretoLegible, uriOtpauth } from '$lib/server/auth/totp';
import {
	altaTotp,
	codigosRestantes,
	exigido,
	factores,
	nuevosCodigos,
	quitarFactor,
	totpDisponible
} from '$lib/server/auth/segundo-factor';

/*
 * «Mi cuenta»: cada usuario de login LOCAL gestiona lo suyo (su nombre, su
 * correo de recuperación y su contraseña). No es Ajustes (eso es solo admin): aquí entra cualquier rol,
 * pero SOLO con login local. En Entra el nombre y la contraseña los lleva
 * Microsoft; emergencia/soporte y el usuario de desarrollo no tienen `local:`.
 */
function idLocal(locals: App.Locals): string | null {
	const oid = locals.usuario?.oid;
	if (!oid || !oid.startsWith('local:') || !loginLocalHabilitado()) return null;
	return oid.slice('local:'.length);
}

export const load = async ({ locals, url }) => {
	const id = idLocal(locals);
	if (!id) redirect(303, '/');
	const correo = locals.usuario!.correo;
	return {
		usuario: (await pendientesAlEntrar(id))?.usuario ?? '',
		nombre: locals.usuario!.nombre,
		correo: correoValido(correo) ? correo : '',
		minimo: MIN_CLAVE,
		segundoFactor: {
			factores: (await factores(id)).map((f) => ({
				...f,
				creada: f.creada.toISOString(),
				ultimoUso: f.ultimoUso?.toISOString() ?? null
			})),
			codigos: await codigosRestantes(id),
			exigido: await exigido(),
			totp: totpDisponible(),
			porIp: sinLlavePorIp(url.hostname)
		}
	};
};

export const actions = {
	/* El selector del menú lateral: de cualquiera, entre como entre. Vacía: la del navegador. */
	zonaHoraria: async ({ request, locals }) => {
		const zona = String((await request.formData()).get('zona') ?? '');
		if (zona && !zonaValida(zona)) return fail(400, { error: 'That time zone does not exist.' });
		await guardarZona(locals.usuario!, zona || null);
		return { mensaje: 'Time zone updated.' };
	},
	nombre: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Only users with local sign-in can change this here.' });
		const nombre = String((await request.formData()).get('nombre') ?? '');
		const r = await cambiarNombrePropio(locals.usuario!.correo, id, nombre);
		if (!r.ok) return fail(400, { error: r.error });
		await renombrarSesiones(locals.usuario!.oid!, r.nombre);
		return { mensaje: 'Name updated.' };
	},
	correo: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Only users with local sign-in can change this here.' });
		const f = await request.formData();
		const correo = String(f.get('correo') ?? '');
		/*
		 * El correo es adonde va el código si se pierde la contraseña: cambiarlo con solo una
		 * sesión robada daría la cuenta para siempre. Se pide también la contraseña de ahora.
		 */
		if (!(await claveCorrecta(id, String(f.get('clave') ?? ''))))
			return fail(400, { error: 'Enter your current password to change the email.' });
		const r = await cambiarCorreo(locals.usuario!.correo, id, correo);
		if (!r.ok) return fail(400, { error: r.error });
		await cambiarCorreoSesiones(locals.usuario!.oid!, r.identidad.correo);
		return { mensaje: 'Email updated. If you lose your password, the code will be sent there.' };
	},
	contrasena: async ({ request, locals, cookies }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Only users with local sign-in can change this here.' });
		const f = await request.formData();
		const actual = String(f.get('actual') ?? '');
		const nueva = String(f.get('nueva') ?? '');
		const repetir = String(f.get('repetir') ?? '');
		if (nueva !== repetir) return fail(400, { error: 'The two new passwords do not match.' });
		const r = await cambiarClavePropia(
			locals.usuario!.correo,
			id,
			actual,
			nueva,
			sesionActual(cookies) ?? undefined
		);
		if (!r.ok) return fail(400, { error: r.error });
		return { mensaje: 'Password changed.' };
	},
	/* Segundo factor: propone un secreto para una app de autenticación (aún no se guarda). */
	empezarTotp: async ({ locals, url }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Only users with local sign-in can change this here.' });
		if (!totpDisponible())
			return fail(409, { error: 'Authenticator apps cannot be used on this node. Use a passkey.' });
		const secreto = generarSecreto();
		const usuario = (await pendientesAlEntrar(id))?.usuario ?? 'user';
		return {
			totp: {
				secreto,
				legible: secretoLegible(secreto),
				qr: qrDataUri(uriOtpauth(secreto, `${usuario}@${url.hostname}`))
			}
		};
	},
	confirmarTotp: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Only users with local sign-in can change this here.' });
		const f = await request.formData();
		const primero = (await factores(id)).length === 0;
		const r = await altaTotp(
			locals.usuario!.correo,
			id,
			String(f.get('secreto') ?? ''),
			String(f.get('codigo') ?? ''),
			String(f.get('nombre') ?? '')
		);
		if (!r.ok) return fail(400, { error: r.error });
		/* El primero trae sus códigos de recuperación. */
		return {
			mensaje: 'Authenticator app added.',
			codigos: primero ? await nuevosCodigos(locals.usuario!.correo, id) : undefined
		};
	},
	quitarFactor: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Only users with local sign-in can change this here.' });
		const f = await request.formData();
		const r = await quitarFactor(
			locals.usuario!.correo,
			id,
			String(f.get('id') ?? ''),
			String(f.get('clave') ?? '')
		);
		if (!r.ok) return fail(400, { error: r.error });
		return { mensaje: 'Sign-in method removed.' };
	},
	codigos: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Only users with local sign-in can change this here.' });
		if (!(await claveCorrecta(id, String((await request.formData()).get('clave') ?? ''))))
			return fail(400, { error: 'Enter your current password to create new recovery codes.' });
		if ((await factores(id)).length === 0)
			return fail(400, { error: 'Add a passkey or an authenticator app first.' });
		return {
			mensaje: 'New recovery codes created. The previous ones no longer work.',
			codigos: await nuevosCodigos(locals.usuario!.correo, id)
		};
	}
};
