/*
 * La configuración inicial: un recorrido por lo que hay que dejar hecho en una consola
 * recién instalada. Cada paso se hace en su pantalla de siempre; aquí se ve el conjunto,
 * se confirma lo que solo sabe la persona y se deja para más adelante lo que no toca hoy.
 */
import { fail, redirect } from '@sveltejs/kit';
import { leerDominio, sugerirDominio } from '$lib/camuflaje';
import { exigir } from '$lib/server/auth/permisos';
import {
	abrirConfiguracion,
	confirmarPaso,
	omitirPaso,
	terminarConfiguracion
} from '$lib/server/configuracion-inicial';
import { guardarIdentidad, identidad } from '$lib/server/identidad';

export const load = async ({ locals, url }) => {
	const u = exigir(locals, 'ajustes');
	return {
		...(await abrirConfiguracion(u)),
		dominioSugerido: sugerirDominio(url.hostname)
	};
};

export const actions = {
	dominio: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const texto = String((await request.formData()).get('dominio') ?? '');
		const dominio = leerDominio(texto);
		if (!dominio)
			return fail(400, {
				paso: 'empresa',
				error: `"${texto.trim()}" is not a domain. Enter it as company.com.`
			});
		await guardarIdentidad(u.correo, { decidido: true, dominio });
		return { paso: 'empresa' };
	},
	confirmar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const paso = String((await request.formData()).get('paso') ?? '');
		const r = await confirmarPaso(u.correo, paso);
		return r.ok ? { paso } : fail(400, { paso, error: r.error });
	},
	omitir: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const paso = String((await request.formData()).get('paso') ?? '');
		const r = await omitirPaso(u.correo, paso);
		if (!r.ok) return fail(400, { paso, error: r.error });
		/* El dominio tiene su propio «ya contestado»: así tampoco lo vuelve a preguntar la franja. */
		if (paso === 'empresa')
			await guardarIdentidad(u.correo, { decidido: true, dominio: (await identidad()).dominio });
		return { paso };
	},
	terminar: async ({ locals }) => {
		const u = exigir(locals, 'ajustes');
		const r = await terminarConfiguracion(u);
		if (!r.ok) return fail(400, { paso: 'final', error: r.error });
		redirect(303, '/?setup=done');
	}
};
