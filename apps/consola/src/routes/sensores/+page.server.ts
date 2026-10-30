import { fail } from '@sveltejs/kit';
import { SIN_IDENTIFICADOR, identificador } from '$lib/identificador';
import { esEntorno } from '$lib/entorno';
import { exigir } from '$lib/server/auth/permisos';
import { redDelFormulario } from '$lib/red';
import { cambiarEntorno, cambiarRed, retirarSensor, sensores, ultimaCuarentena } from '$lib/server/gestion';
import { listaDestinos } from '$lib/server/destinos';
import { esCommunity } from '$lib/server/edicion';
import { altaSensorRemoto, lineaSensorRemoto } from '$lib/server/sensores-remotos';

export const load = async ({ url }) => {
	const destinos = await listaDestinos();
	return {
		ahora: Date.now(),
		baja: url.searchParams.has('baja'),
		/* En community no se añaden destinos a mano (no hay señuelos manuales): sin su sección. */
		community: esCommunity(),
		sensores: await sensores(),
		cuarentena: await ultimaCuarentena(),
		/* La ficha de la máquina de cada sensor, y los destinos sin sensor (un servidor, un NAS, una cuenta de nube). */
		fichas: Object.fromEntries(destinos.flatMap((d) => (d.sensor ? [[d.sensor.id, d.id]] : []))),
		sinSensor: destinos.filter((d) => !d.sensor)
	};
};

export const actions = {
	crear: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const nombre = String(f.get('nombre') ?? '').trim();
		const v = { id: identificador(String(f.get('id') ?? ''), nombre), nombre };
		if (!v.id) return fail(400, { error: SIN_IDENTIFICADOR, ...v });
		if (!v.nombre) return fail(400, { error: 'El nombre es obligatorio.', ...v });
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
	red: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const id = String(f.get('id'));
		const r = redDelFormulario(f);
		if ('error' in r) return fail(400, { error: r.error, cambiando: id });
		if (!(await cambiarRed(u.correo, id, r)))
			return fail(404, { error: 'Ese sensor ya no existe.' });
		return { mensaje: 'Red del sensor guardada.' };
	},
	entorno: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const id = String(f.get('id'));
		const v = String(f.get('entorno') ?? '');
		/* Vacío = sin entorno (null); cualquier otra cosa tiene que ser uno de los tres válidos. */
		const entorno = v === '' ? null : esEntorno(v) ? v : undefined;
		if (entorno === undefined) return fail(400, { error: 'Entorno no válido.', cambiando: id });
		if (!(await cambiarEntorno(u.correo, id, entorno)))
			return fail(404, { error: 'Ese sensor ya no existe.' });
		return { mensaje: 'Entorno del sensor guardado.' };
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
