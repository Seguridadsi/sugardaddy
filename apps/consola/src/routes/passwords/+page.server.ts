import { fail } from '@sveltejs/kit';
import {
	buscarContrasena,
	contrasenas,
	palabras,
	revelarPorHuella
} from '$lib/server/credenciales';
import { nombresTrampas } from '$lib/server/consultas';
import { exigir } from '$lib/server/auth/permisos';
import { puede } from '$lib/permisos';

type Fila = Awaited<ReturnType<typeof contrasenas>>[number];
const paraPagina = (filas: Fila[]) =>
	filas.map((f) => ({
		...f,
		huella: f.huella as string,
		primera: new Date(f.primera).toISOString(),
		ultima: new Date(f.ultima).toISOString()
	}));

/*
 * Las contraseñas probadas, enmascaradas y agrupadas por su huella. Verlas
 * enteras o buscar una es revelarlas: solo con ver-credenciales, y auditado
 * (credenciales.ts). La búsqueda va por POST: una contraseña no viaja en la URL.
 */
export const load = async ({ locals }) => ({
	ahora: Date.now(),
	filas: paraPagina(await contrasenas()),
	palabras: await palabras(),
	nombres: await nombresTrampas(),
	revelar: !!locals.usuario && puede(locals.usuario.roles, 'ver-credenciales')
});

export const actions = {
	revelar: async ({ request, locals }) => {
		const u = exigir(locals, 'ver-credenciales');
		const h = String((await request.formData()).get('huella') ?? '');
		const r = await revelarPorHuella(u.correo, h);
		if (!r.ok) return fail(400, { error: r.error, huella: h });
		return { revelada: { huella: h, contrasena: r.contrasena ?? '' } };
	},
	buscar: async ({ request, locals }) => {
		const u = exigir(locals, 'ver-credenciales');
		const buscada = String((await request.formData()).get('buscar') ?? '');
		if (!buscada) return { busqueda: null };
		const filas = await buscarContrasena(u.correo, buscada);
		if (!filas)
			return fail(409, {
				error: 'This node does not have its key (CLAVE_SECRETOS): passwords cannot be looked up.'
			});
		return { busqueda: { encontrada: filas.length > 0, filas: paraPagina(filas) } };
	}
};
