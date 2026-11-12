import { fail } from '@sveltejs/kit';
import { SIN_IDENTIFICADOR, identificador } from '$lib/identificador';
import { esEntorno } from '$lib/entorno';
import { exigir } from '$lib/server/auth/permisos';
import { redDelFormulario } from '$lib/red';
import {
	cambiarEntorno,
	cambiarRed,
	cambiarRegistrarPropio,
	retirarSensor,
	sensores,
	ultimaCuarentena
} from '$lib/server/gestion';
import { listaDestinos } from '$lib/server/destinos';
import { esCommunity } from '$lib/server/edicion';
import { ErrorCliente, altaSensorRemoto, lineaSensorRemoto } from '$lib/server/sensores-remotos';
import { nombreConsola } from '$lib/server/direccion-consola';
import { esLocal, quitarSensorDelAcceso } from '$lib/server/acceso';
import { normalizarIp } from '$lib/server/pruebas';
import { silenciosPorObjeto } from '$lib/server/alcance-ficha';

export const load = async ({ url }) => {
	const destinos = await listaDestinos();
	return {
		ahora: Date.now(),
		baja: url.searchParams.has('baja'),
		/* En community no se añaden destinos a mano (no hay señuelos manuales): sin su sección. */
		community: esCommunity(),
		sensores: await sensores(),
		/* Por qué salidas de avisos no sale lo de cada sensor (lib/alcance.ts). */
		silencios: (await silenciosPorObjeto()).sensores,
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
		/*
		 * Dónde está: uno expuesto a internet no debe proponer nombres con el dominio
		 * interno del cliente, y eso depende de que se sepa desde el primer honeypot.
		 */
		const donde = String(f.get('entorno') ?? '');
		const v = {
			id: identificador(String(f.get('id') ?? ''), nombre),
			nombre,
			entorno: esEntorno(donde) ? donde : null
		};
		/* La IP de su máquina: con el acceso a la consola limitado, entra en la lista. */
		const ip = String(f.get('ip') ?? '').trim();
		if (!v.id) return fail(400, { error: SIN_IDENTIFICADOR, ...v, ip });
		if (!v.nombre) return fail(400, { error: 'The name is required.', ...v, ip });
		try {
			const linea = await altaSensorRemoto(u.correo, v, undefined, ip);
			if (!linea)
				return fail(400, { error: 'A sensor with that identifier already exists.', ...v, ip });
			return { linea, para: v.id, consola: nombreConsola() };
		} catch (e) {
			return fail(e instanceof ErrorCliente ? 400 : 500, { error: (e as Error).message, ...v, ip });
		}
	},
	linea: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const id = String(f.get('id'));
		try {
			const linea = await lineaSensorRemoto(u.correo, id, String(f.get('ip') ?? '').trim());
			return linea
				? { linea, para: id, consola: nombreConsola() }
				: fail(404, { error: 'That sensor is not remote.' });
		} catch (e) {
			return fail(e instanceof ErrorCliente ? 400 : 500, {
				error: (e as Error).message,
				cambiando: id
			});
		}
	},
	red: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const id = String(f.get('id'));
		const r = redDelFormulario(f);
		if ('error' in r) return fail(400, { error: r.error, cambiando: id });
		if (!(await cambiarRed(u.correo, id, r)))
			return fail(404, { error: 'That sensor no longer exists.' });
		return { mensaje: 'Sensor network saved.' };
	},
	entorno: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const id = String(f.get('id'));
		const v = String(f.get('entorno') ?? '');
		/* Vacío = sin entorno (null); cualquier otra cosa tiene que ser uno de los tres válidos. */
		const entorno = v === '' ? null : esEntorno(v) ? v : undefined;
		if (entorno === undefined) return fail(400, { error: 'Invalid environment.', cambiando: id });
		if (!(await cambiarEntorno(u.correo, id, entorno)))
			return fail(404, { error: 'That sensor no longer exists.' });
		return { mensaje: 'Sensor environment saved.' };
	},
	registrarPropio: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const registrar = f.get('registrar') === 'si';
		if (!(await cambiarRegistrarPropio(u.correo, String(f.get('id')), registrar)))
			return fail(404, { error: 'That sensor no longer exists.' });
		return {
			mensaje: registrar
				? 'The sensor will record connections from its own machine.'
				: 'The sensor will stop recording connections from its own machine.'
		};
	},
	retirar: async ({ request, locals, getClientAddress }) => {
		const u = exigir(locals, 'ajustes');
		const id = String((await request.formData()).get('id'));
		const r = await retirarSensor(u.correo, id);
		if (r === 'tiene trampas') return fail(400, { error: 'Remove its honeypots first.' });
		/* Su máquina deja de poder entrar al puerto de la consola (salvo que eso deje fuera a quien lo borra). */
		let ip: string | null = null;
		try {
			ip = normalizarIp(getClientAddress());
		} catch {
			ip = null;
		}
		await quitarSensorDelAcceso(u.correo, id, ip, esLocal(ip));
		return {
			mensaje:
				r === 'desactivado'
					? 'The sensor has recorded events: its history is kept and its token is invalidated.'
					: 'Sensor removed.'
		};
	}
};
