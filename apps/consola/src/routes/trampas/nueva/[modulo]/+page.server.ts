import { error, fail, redirect } from '@sveltejs/kit';
import { tipoEvento, validarParametros } from '@sugardaddy/contrato';
import { SIN_IDENTIFICADOR, identificador } from '$lib/identificador';
import { darDeAlta, dondePoner, formaEn } from '$lib/server/alta';
import { exigir } from '$lib/server/auth/permisos';
import { trampasAutorizadas } from '$lib/server/catalogo';
import { existeTrampa } from '$lib/server/consultas';

/*
 * Poner una trampa (docs/diseno/modulo-despliegue.md §7.3, pasos 9 y 11). Sin
 * ?destino, el paso «¿dónde?»: cada destino con lo que diría el elector. Con
 * ?destino (y ?via, si el cliente eligió otra forma), el formulario de la vía
 * que vale allí. Al guardar decide el elector con los valores de verdad. Una
 * de contenedor la pone el sensor; una a mano se guarda con sus pasos, y se
 * va a su ficha a seguirlos.
 */
async function modulo(id: string) {
	const h = (await trampasAutorizadas()).find((x) => x.id === id);
	if (!h) error(404, 'Ese módulo no está en el catálogo o no está autorizado para este cliente');
	if (!h.vias.length) error(404, 'Esta honeycosa aún no tiene ninguna forma de ponerse.');
	return h;
}

export const load = async ({ params, url }) => {
	const h = await modulo(params.modulo);
	const destino = url.searchParams.get('destino');
	const via = url.searchParams.get('via') ?? undefined;
	const forma = destino === null ? null : await formaEn(h, destino, via);
	if (destino !== null && !forma) error(404, 'Ese destino no existe.');
	return {
		modulo: {
			id: h.id,
			nombre: h.nombre,
			descripcion: h.descripcion,
			tipo: tipoEvento(h),
			parametros: h.parametros,
			procedencia: h.procedencia ?? null
		},
		donde: forma ? null : await dondePoner(h),
		forma
	};
};

export const actions = {
	default: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const h = await modulo(params.modulo);
		const form = await request.formData();
		const nombre = String(form.get('nombre') ?? '').trim();
		const id = identificador(String(form.get('id') ?? ''), nombre);
		const destino = String(form.get('destino') ?? '');
		const via = String(form.get('via') ?? '') || undefined;

		const valores: Record<string, unknown> = {};
		for (const [k, v] of form)
			if (k.startsWith('p.')) valores[k.slice(2)] = String(v).replace(/\r\n/g, '\n');

		const errores: string[] = [];
		if (!id) errores.push(SIN_IDENTIFICADOR);
		else if (await existeTrampa(id))
			errores.push('Identificador: ya hay una trampa con ese nombre');
		if (!nombre) errores.push('Nombre visible: obligatorio');
		if (!destino) errores.push('Destino: elige dónde ponerla');
		const p = validarParametros(h.parametros, valores);
		if (!p.ok) errores.push(...p.errores);
		const datos = { id, nombre, valores };
		if (!p.ok || errores.length) return fail(400, { ...datos, errores, motivos: [] });

		/* El elector decide con autoridad: si la vía pedida no vale aquí, vuelven sus motivos. */
		const r = await darDeAlta(u.correo, {
			honeycosa: h,
			id,
			nombre,
			destino,
			via,
			parametros: p.valor
		});
		if (r === 'con-pasos') redirect(303, `/trampas/${encodeURIComponent(id)}`);
		if (r !== 'creada') return fail(400, { ...datos, ...r });
		redirect(303, `/trampas?creado=${encodeURIComponent(nombre)}`);
	}
};
