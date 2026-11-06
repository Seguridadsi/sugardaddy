import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { exigir } from '$lib/server/auth/permisos';
import { nombrarRed } from '$lib/server/gestion';
import { mapaDespliegue } from '$lib/server/mapa-despliegue';
import { origenDe } from '$lib/server/mapa-despliegue-armar';

export const load = async ({ url, depends }) => {
	/* La página se pone al día sola con esto, sin volver a leer todo lo de la barra. */
	depends('app:mapa');
	return { ahora: Date.now(), mapa: await mapaDespliegue(origenDe(env.ORIGIN, url)) };
};

export const actions = {
	/* El nombre de una red es de todos los sensores que están en ella. */
	nombrar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const sensores = f.getAll('sensor').map(String).filter(Boolean);
		const nombre = String(f.get('nombre') ?? '').trim();
		if (!sensores.length) return fail(400, { error: 'That network no longer has any sensors.' });
		if (nombre.length > 60)
			return fail(400, { error: 'The network name can be up to 60 characters.' });
		await nombrarRed(u.correo, sensores, nombre || null);
		return { mensaje: nombre ? `Network saved as "${nombre}".` : 'Network name removed.' };
	}
};
