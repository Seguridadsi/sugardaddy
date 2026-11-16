import { fail, redirect } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import {
	cambiarPolitica,
	estadoSensoresMtls,
	huellaCertificado,
	leerPolitica,
	raizSensores
} from '$lib/server/ca-sensores';
import { estadoClave } from '$lib/server/secretos';

/* Los certificados de cliente de los sensores remotos (docs/diseno/mtls-sensores.md). */
export const load = async ({ locals }) => {
	exigir(locals, 'ajustes');
	const raiz = await raizSensores();
	return {
		politica: await leerPolitica(),
		sensores: await estadoSensoresMtls(),
		ca: raiz ? { huella: huellaCertificado(raiz) } : null,
		sinClave: estadoClave() !== 'lista'
	};
};

export const actions = {
	politica: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const politica = f.get('politica') === 'require' ? 'require' : 'grace';
		const r = await cambiarPolitica(u.correo, politica, f.get('cortar') === 'si');
		if (!r.ok) return fail(400, { error: r.error });
		redirect(303, '/settings/sensor-certificates?tab=policy&guardada=1');
	}
};
