import { fail, redirect } from '@sveltejs/kit';
import {
	MIN_CLAVE,
	cambiarClavePropia,
	cambiarCorreo,
	cambiarNombrePropio,
	correoValido,
	loginLocalHabilitado,
	pendientesAlEntrar
} from '$lib/server/auth/local';
import { cambiarCorreoSesiones, renombrarSesiones } from '$lib/server/auth/sesion';

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

export const load = async ({ locals }) => {
	const id = idLocal(locals);
	if (!id) redirect(303, '/');
	const correo = locals.usuario!.correo;
	return {
		usuario: (await pendientesAlEntrar(id))?.usuario ?? '',
		nombre: locals.usuario!.nombre,
		correo: correoValido(correo) ? correo : '',
		minimo: MIN_CLAVE
	};
};

export const actions = {
	nombre: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Esto solo lo cambian aquí los usuarios con login local.' });
		const nombre = String((await request.formData()).get('nombre') ?? '');
		const r = await cambiarNombrePropio(locals.usuario!.correo, id, nombre);
		if (!r.ok) return fail(400, { error: r.error });
		await renombrarSesiones(locals.usuario!.oid!, r.nombre);
		return { mensaje: 'Nombre actualizado.' };
	},
	correo: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Esto solo lo cambian aquí los usuarios con login local.' });
		const correo = String((await request.formData()).get('correo') ?? '');
		const r = await cambiarCorreo(locals.usuario!.correo, id, correo);
		if (!r.ok) return fail(400, { error: r.error });
		await cambiarCorreoSesiones(locals.usuario!.oid!, r.identidad.correo);
		return { mensaje: 'Correo actualizado. Si pierdes la contraseña, el código irá ahí.' };
	},
	contrasena: async ({ request, locals }) => {
		const id = idLocal(locals);
		if (!id) return fail(403, { error: 'Esto solo lo cambian aquí los usuarios con login local.' });
		const f = await request.formData();
		const actual = String(f.get('actual') ?? '');
		const nueva = String(f.get('nueva') ?? '');
		const repetir = String(f.get('repetir') ?? '');
		if (nueva !== repetir) return fail(400, { error: 'Las dos contraseñas nuevas no coinciden.' });
		const r = await cambiarClavePropia(locals.usuario!.correo, id, actual, nueva);
		if (!r.ok) return fail(400, { error: r.error });
		return { mensaje: 'Contraseña cambiada.' };
	}
};
