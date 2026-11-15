import { error, fail, redirect } from '@sveltejs/kit';
import { tipoEvento } from '@sugardaddy/contrato';
import { darDeAlta, dondePoner, formaEn } from '$lib/server/alta';
import { comprobarPedido, moduloParaAlta } from '$lib/server/alta-consola';
import { exigir } from '$lib/server/auth/permisos';
import { esDePartner } from '$lib/server/catalogo-partner';
import { propuestasDeAlta } from '$lib/server/identidad';
import { piezaParaAlta, plantillaPorId } from '$lib/server/plantillas';

/*
 * Poner una trampa (docs/diseno/modulo-despliegue.md §7.3, pasos 9 y 11). Sin
 * ?destino, el paso «¿dónde?»: cada destino con lo que diría el elector. Con
 * ?destino (y ?via, si el cliente eligió otra forma), el formulario de la vía
 * que vale allí. Al guardar decide el elector con los valores de verdad. Una
 * de contenedor la pone el sensor; una a mano se guarda con sus pasos, y se
 * va a su ficha a seguirlos.
 */
/* Autorizado, cubierto por la licencia y con alguna vía (alta-consola.ts, como al aprobar una petición). */
async function modulo(id: string) {
	const m = await moduloParaAlta(id);
	if (!m.ok) error(m.estado, m.error);
	return m.h;
}

export const load = async ({ params, url }) => {
	const h = await modulo(params.modulo);
	const destino = url.searchParams.get('destino');
	const via = url.searchParams.get('via') ?? undefined;
	const forma = destino === null ? null : await formaEn(h, destino, via);
	if (destino !== null && !forma) error(404, 'That target does not exist.');
	const pieza = await piezaParaAlta(
		url.searchParams.get('plantilla'),
		url.searchParams.get('pieza'),
		h.id
	);
	return {
		modulo: {
			id: h.id,
			nombre: h.nombre,
			descripcion: h.descripcion,
			tipo: tipoEvento(h),
			parametros: h.parametros,
			procedencia: h.procedencia ?? null,
			dePartner: esDePartner(h.id)
		},
		donde: forma ? null : await dondePoner(h),
		forma,
		/* Los nombres que tocan según el dominio del cliente, listos en el formulario; por encima, lo que fija su plantilla. */
		propuestas:
			destino !== null && forma
				? { ...(await propuestasDeAlta(h, destino)), ...(pieza?.parametros ?? {}) }
				: {},
		/* La plantilla desde la que se pone (?plantilla, ?pieza): la trampa queda en su grupo. */
		pieza: pieza && {
			plantilla: pieza.plantilla,
			plantillaNombre: pieza.plantillaNombre,
			clave: url.searchParams.get('pieza'),
			nombre: pieza.nombre
		}
	};
};

export const actions = {
	default: async ({ params, request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const h = await modulo(params.modulo);
		const form = await request.formData();
		const nombre = String(form.get('nombre') ?? '').trim();
		/* La dirección de la máquina en la que se publica; vacía, en todas. */
		const escucha = String(form.get('escucha') ?? '').trim();
		/* Solo una plantilla que existe: el grupo no es texto libre. */
		const plantilla = (await plantillaPorId(String(form.get('plantilla') ?? '')))?.id;

		const valores: Record<string, string> = {};
		for (const [k, v] of form)
			if (k.startsWith('p.')) valores[k.slice(2)] = String(v).replace(/\r\n/g, '\n');

		/* Las comprobaciones de siempre (alta-consola.ts), las mismas que al aprobar una petición. */
		const c = await comprobarPedido(h, {
			id: String(form.get('id') ?? ''),
			nombre,
			destino: String(form.get('destino') ?? ''),
			via: String(form.get('via') ?? '') || undefined,
			escucha,
			valores,
			...(plantilla ? { plantilla } : {})
		});
		const datos = { id: c.ok ? c.valor.id : c.id, nombre, valores, escucha };
		if (!c.ok) return fail(400, { ...datos, errores: c.errores, motivos: [] });

		/* El elector decide con autoridad: si la vía pedida no vale aquí, vuelven sus motivos. */
		const r = await darDeAlta(u.correo, { honeycosa: h, ...c.valor });
		if (r === 'con-pasos') redirect(303, `/decoys/${encodeURIComponent(c.valor.id)}`);
		if (r !== 'creada') return fail(400, { ...datos, ...r });
		redirect(303, `/decoys?creado=${encodeURIComponent(nombre)}`);
	}
};
