import { error, fail, redirect } from '@sveltejs/kit';
import { entreComillas } from '$lib/formato';
import { SIN_IDENTIFICADOR, identificador } from '$lib/identificador';
import { exigir } from '$lib/server/auth/permisos';
import {
	darDeBajaDestino,
	edicionDestino,
	editarDestino,
	fichaDestino,
	leerFormulario,
	valoresDeFormulario
} from '$lib/server/destinos';
import { DestinoNoDisponible, regenerarToken } from '$lib/server/gestion';
import { ErrorCliente, altaSensorRemoto } from '$lib/server/sensores-remotos';
import { nombreConsola } from '$lib/server/direccion-consola';
import { alcanceDeFicha, fijarAlcance, leerAlcance } from '$lib/server/alcance-ficha';

export const load = async ({ params, url }) => {
	const destino = await fichaDestino(params.id);
	if (!destino) error(404, 'That target does not exist.');
	return {
		ahora: Date.now(),
		creado: url.searchParams.has('creado'),
		destino,
		/* Por qué salidas avisa lo de este sensor (lib/alcance.ts); sin sensor, no hay qué decir. */
		alcance: destino.sensor ? await alcanceDeFicha('sensor', destino.sensor.id) : null
	};
};

export const actions = {
	/* Lo que dice el sensor de este destino de una salida: enviar, no enviar o heredar. */
	alcance: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const v = leerAlcance(await request.formData());
		const destino = await fichaDestino(params.id);
		if (!destino) error(404, 'That target does not exist.');
		if (!v || !destino.sensor)
			return fail(400, {
				accion: 'alcance' as const,
				errores: ['That output or value is not valid.']
			});
		if (!(await fijarAlcance(u.correo, { ...v, nivel: 'sensor', objeto: destino.sensor.id })))
			return fail(400, { accion: 'alcance' as const, errores: ['That output no longer exists.'] });
		return { accion: 'alcance' as const, mensaje: 'Alerts for this sensor saved.' };
	},

	/* El formulario corto, salvo lo que ya dice su sensor (§5.3). */
	editar: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const e = await edicionDestino(params.id);
		if (!e) error(404, 'That target does not exist.');
		const f = await request.formData();
		const r = leerFormulario(f, e.tipo, e);
		const fallo = (errores: string[]) =>
			fail(400, { accion: 'editar' as const, errores, valores: valoresDeFormulario(f) });
		if (r.errores.length) return fallo(r.errores);
		const x = await editarDestino(u.correo, params.id, {
			nombre: r.nombre,
			descripcion: r.descripcion,
			bloqueados: e.bloqueados
		});
		if (x === 'no-existe') error(404, 'That target does not exist.');
		if (x !== 'editado') {
			const varias = x.dependientes.length > 1;
			return fallo([
				`${varias ? 'The honeypots' : 'The honeypot'} ${entreComillas(x.dependientes)} ${varias ? 'point' : 'points'} to the address of this target: remove ${varias ? 'them' : 'it'} first.`
			]);
		}
		return { accion: 'editar' as const, mensaje: 'Changes saved.' };
	},

	/*
	 * «Instalar un sensor aquí» (§5.3): da de alta un sensor remoto que pasa a
	 * ser el de este destino, sin crear otro. Como en Sensores, solo quien
	 * administra la consola, que es quien da de alta sensores.
	 */
	instalar: async ({ params, request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const nombre = String(f.get('nombre') ?? '').trim();
		const v = { id: identificador(String(f.get('id') ?? ''), nombre), nombre };
		const ip = String(f.get('ip') ?? '').trim();
		const fallo = (status: number, texto: string) =>
			fail(status, { accion: 'instalar' as const, error: texto, ...v, ip });
		if (!v.id) return fallo(400, SIN_IDENTIFICADOR);
		if (!v.nombre) return fallo(400, 'The name is required.');
		try {
			const linea = await altaSensorRemoto(u.correo, v, params.id, ip);
			if (!linea) return fallo(400, 'A sensor with that identifier already exists.');
			return { linea, para: v.id, consola: nombreConsola() };
		} catch (e) {
			if (e instanceof DestinoNoDisponible) return fallo(409, e.message);
			if (e instanceof ErrorCliente) return fallo(400, e.message);
			return fallo(500, (e as Error).message);
		}
	},

	/*
	 * Cortar ya el token de un sensor remoto, para cuando se sospecha que se ha
	 * filtrado: el que tenía deja de valer en ese momento, y también el que
	 * estuviera pendiente de estrenar. El sensor queda fuera hasta que se pega una
	 * línea de instalación nueva en su máquina. El del propio nodo no se corta
	 * desde aquí: no tiene línea con la que volver.
	 */
	cortarToken: async ({ params, request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const destino = await fichaDestino(params.id);
		if (!destino) error(404, 'That target does not exist.');
		const f = await request.formData();
		if (!destino.sensor?.remoto)
			return fail(400, {
				accion: 'cortar' as const,
				error: 'Only the token of a remote sensor can be revoked from here.'
			});
		if (f.get('entiendo') !== 'si')
			return fail(400, {
				accion: 'cortar' as const,
				error: 'Tick the box to confirm: the sensor stops reporting until you reinstall it.'
			});
		if (!(await regenerarToken(u.correo, destino.sensor.id)))
			return fail(400, { accion: 'cortar' as const, error: 'That sensor no longer exists.' });
		return {
			accion: 'cortar' as const,
			mensaje:
				'Token revoked. The sensor is out until you generate a new install line in Sensors and run it on its machine.'
		};
	},
	baja: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await darDeBajaDestino(u.correo, params.id);
		if (r === 'borrado') redirect(303, '/sensors?baja');
		if (r === 'no-existe') error(404, 'That target does not exist.');
		return fail(400, {
			accion: 'baja' as const,
			error:
				r === 'tiene sensor'
					? 'This target has a sensor: it is removed by removing its sensor, in Sensors.'
					: 'Remove its honeypots first.'
		});
	}
};
