import { fail } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import { retirarSensor, sensores, ultimaCuarentena } from '$lib/server/gestion';
import { altaSensorRemoto, lineaSensorRemoto } from '$lib/server/sensores-remotos';

export const load = async () => ({
	ahora: Date.now(),
	sensores: await sensores(),
	cuarentena: await ultimaCuarentena()
});

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const actions = {
	crear: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const v = {
			id: String(f.get('id') ?? '').trim(),
			nombre: String(f.get('nombre') ?? '').trim(),
			segmento: String(f.get('segmento') ?? '').trim()
		};
		if (!SLUG.test(v.id))
			return fail(400, { error: 'Identificador: minúsculas, números y guiones.', ...v });
		if (!v.nombre || !v.segmento)
			return fail(400, { error: 'Nombre y segmento son obligatorios.', ...v });
		try {
			const linea = await altaSensorRemoto(u.correo, v);
			if (!linea) return fail(400, { error: 'Ya hay un sensor con ese identificador.', ...v });
			return { linea, para: v.id };
		} catch (e) {
			return fail(500, { error: (e as Error).message, ...v });
		}
	},
	linea: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const id = String((await request.formData()).get('id'));
		try {
			const linea = await lineaSensorRemoto(u.correo, id);
			return linea ? { linea, para: id } : fail(404, { error: 'Ese sensor no es remoto.' });
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	retirar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const id = String((await request.formData()).get('id'));
		const r = await retirarSensor(u.correo, id);
		if (r === 'tiene trampas') return fail(400, { error: 'Retira antes sus trampas.' });
		return {
			mensaje:
				r === 'desactivado'
					? 'El sensor tiene eventos registrados: se conserva su historia y se invalida su token.'
					: 'Sensor retirado.'
		};
	}
};
