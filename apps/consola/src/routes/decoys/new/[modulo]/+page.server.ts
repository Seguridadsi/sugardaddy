import { error, fail, redirect } from '@sveltejs/kit';
import { motivo, tipoEvento, validarParametros } from '@sugardaddy/contrato';
import { SIN_IDENTIFICADOR, identificador } from '$lib/identificador';
import { darDeAlta, dondePoner, formaEn } from '$lib/server/alta';
import { exigir } from '$lib/server/auth/permisos';
import { coberturaLicencia } from '$lib/server/candado';
import { esDePartner } from '$lib/server/catalogo-partner';
import { trampasAutorizadas } from '$lib/server/catalogo';
import { existeTrampa } from '$lib/server/consultas';
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
async function modulo(id: string) {
	const h = (await trampasAutorizadas()).find((x) => x.id === id);
	if (!h) error(404, 'That module is not in the catalog or is not authorized for this customer.');
	/* Una de pago que la licencia no cubre se quedaría en espera: ni se pone. */
	const licencia = (await coberturaLicencia())(h.id);
	if (licencia !== 'cubierta') error(403, motivo(licencia).texto);
	if (!h.vias.length) error(404, 'This honeypot has no way to be deployed yet.');
	return h;
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
		const id = identificador(String(form.get('id') ?? ''), nombre);
		const destino = String(form.get('destino') ?? '');
		const via = String(form.get('via') ?? '') || undefined;
		/* La dirección de la máquina en la que se publica; vacía, en todas. */
		const escucha = String(form.get('escucha') ?? '').trim();
		/* Solo una plantilla que existe: el grupo no es texto libre. */
		const plantilla = (await plantillaPorId(String(form.get('plantilla') ?? '')))?.id;

		const valores: Record<string, unknown> = {};
		for (const [k, v] of form)
			if (k.startsWith('p.')) valores[k.slice(2)] = String(v).replace(/\r\n/g, '\n');

		const errores: string[] = [];
		if (!id) errores.push(SIN_IDENTIFICADOR);
		else if (await existeTrampa(id))
			errores.push('Identifier: a honeypot with that name already exists');
		if (!nombre) errores.push('Display name: required');
		if (!destino) errores.push('Target: choose where to deploy it');
		const p = validarParametros(h.parametros, valores);
		if (!p.ok) errores.push(...p.errores);
		const datos = { id, nombre, valores, escucha };
		if (!p.ok || errores.length) return fail(400, { ...datos, errores, motivos: [] });

		/* El elector decide con autoridad: si la vía pedida no vale aquí, vuelven sus motivos. */
		const r = await darDeAlta(u.correo, {
			honeycosa: h,
			id,
			nombre,
			destino,
			via,
			parametros: p.valor,
			escucha: escucha || null,
			...(plantilla ? { plantilla } : {})
		});
		if (r === 'con-pasos') redirect(303, `/decoys/${encodeURIComponent(id)}`);
		if (r !== 'creada') return fail(400, { ...datos, ...r });
		redirect(303, `/decoys?creado=${encodeURIComponent(nombre)}`);
	}
};
