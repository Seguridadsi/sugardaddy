import { error, fail, redirect } from '@sveltejs/kit';
import { entreComillas } from '$lib/formato';
import { exigir } from '$lib/server/auth/permisos';
import {
	darDeBajaDestino,
	edicionDestino,
	editarDestino,
	fichaDestino,
	leerFormulario,
	valoresDeFormulario
} from '$lib/server/destinos';
import { DestinoNoDisponible } from '$lib/server/gestion';
import { ErrorCliente, altaSensorRemoto } from '$lib/server/sensores-remotos';

export const load = async ({ params, url }) => {
	const destino = await fichaDestino(params.id);
	if (!destino) error(404, 'Ese destino no existe.');
	return { ahora: Date.now(), creado: url.searchParams.has('creado'), destino };
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const actions = {
	/* El formulario corto, salvo lo que ya dice su sensor (§5.3). */
	editar: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const e = await edicionDestino(params.id);
		if (!e) error(404, 'Ese destino no existe.');
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
		if (x === 'no-existe') error(404, 'Ese destino no existe.');
		if (x !== 'editado') {
			const varias = x.dependientes.length > 1;
			return fallo([
				`${varias ? 'Las trampas' : 'La trampa'} ${entreComillas(x.dependientes)} ${varias ? 'apuntan' : 'apunta'} a la dirección de este destino: ${varias ? 'retíralas' : 'retírala'} primero.`
			]);
		}
		return { accion: 'editar' as const, mensaje: 'Cambios guardados.' };
	},

	/*
	 * «Instalar un sensor aquí» (§5.3): da de alta un sensor remoto que pasa a
	 * ser el de este destino, sin crear otro. Como en Sensores, solo quien
	 * administra la consola, que es quien da de alta sensores.
	 */
	instalar: async ({ params, request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const v = {
			id: String(f.get('id') ?? '').trim(),
			nombre: String(f.get('nombre') ?? '').trim(),
			segmento: String(f.get('segmento') ?? '').trim()
		};
		const fallo = (status: number, texto: string) =>
			fail(status, { accion: 'instalar' as const, error: texto, ...v });
		if (!SLUG.test(v.id)) return fallo(400, 'Identificador: minúsculas, números y guiones.');
		if (!v.nombre || !v.segmento) return fallo(400, 'Nombre y segmento son obligatorios.');
		try {
			const linea = await altaSensorRemoto(u.correo, v, params.id);
			if (!linea) return fallo(400, 'Ya hay un sensor con ese identificador.');
			return { linea, para: v.id };
		} catch (e) {
			if (e instanceof DestinoNoDisponible) return fallo(409, e.message);
			if (e instanceof ErrorCliente) return fallo(503, e.message);
			return fallo(500, (e as Error).message);
		}
	},

	baja: async ({ params, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await darDeBajaDestino(u.correo, params.id);
		if (r === 'borrado') redirect(303, '/destinos?baja');
		if (r === 'no-existe') error(404, 'Ese destino no existe.');
		return fail(400, {
			accion: 'baja' as const,
			error:
				r === 'tiene sensor'
					? 'Este destino tiene sensor: se da de baja retirando su sensor, en Sensores.'
					: 'Retira antes sus trampas.'
		});
	}
};
