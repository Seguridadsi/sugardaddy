import { fail, redirect } from '@sveltejs/kit';
import { TIPOS_DESTINO } from '$lib/destinos';
import { exigir } from '$lib/server/auth/permisos';
import { crearDestino, leerFormulario, valoresDeFormulario } from '$lib/server/destinos';

export const actions = {
	/* Un destino sin sensor, descrito con el formulario corto (§5.2). */
	default: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const f = await request.formData();
		const tipo = TIPOS_DESTINO.find((t) => t.valor === f.get('tipo'))?.valor;
		const r = leerFormulario(f, tipo ?? '');
		if (!tipo) r.errores.unshift('Qué es: elige una opción de la lista.');
		if (!tipo || r.errores.length)
			return fail(400, {
				errores: r.errores,
				tipo: String(f.get('tipo') ?? ''),
				valores: valoresDeFormulario(f)
			});
		const id = await crearDestino(u.correo, { nombre: r.nombre, tipo, descripcion: r.descripcion });
		redirect(303, `/destinos/${encodeURIComponent(id)}?creado`);
	}
};
