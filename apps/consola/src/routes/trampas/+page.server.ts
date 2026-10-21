import { fail } from '@sveltejs/kit';
import { tipoEvento } from '@sugardaddy/contrato';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { exigir } from '$lib/server/auth/permisos';
import { catalogoConSuscripcion, desplegable } from '$lib/server/catalogo';
import { cambiarTrampa, retirarTrampa } from '$lib/server/gestion';
import { trampasConEventos } from '$lib/server/consultas';
import { noSeParaPor, recibeSenalDe } from '$lib/formato';

/*
 * Cada trampa, desplegada o del catálogo, lleva la procedencia de su módulo y
 * su tipo de servicio: la lista pone con ellos su icono (iconoTrampa), el
 * logotipo del honeypot en que se basa, el pictograma de su tipo o la abeja.
 * Una desplegada de un módulo que ya no está en el catálogo va sin
 * procedencia, con el pictograma de su tipo si lo tiene.
 */
export const load = async ({ url }) => {
	const catalogo = await catalogoConSuscripcion();
	const procedencias = new Map(catalogo.map((m) => [m.id, m.procedencia ?? null]));
	return {
		creado: url.searchParams.get('creado'),
		cambiado: url.searchParams.get('cambiado'),
		quitada: url.searchParams.get('quitada'),
		desplegados: (await trampasConEventos()).map((t) => ({
			...t,
			procedencia: procedencias.get(t.modulo) ?? null,
			pictograma: tipoDeServicio(t.modulo)
		})),
		catalogo: catalogo.map((m) => ({
			id: m.id,
			nombre: m.nombre,
			tipo: tipoEvento(m),
			incluida: m.incluida,
			/* Tiene alguna vía que esta consola sabe poner (en un sensor o a mano). */
			desplegable: desplegable(m),
			resumen: m.ficha?.detecta ?? m.descripcion,
			procedencia: m.procedencia ?? null,
			pictograma: tipoDeServicio(m.id)
		}))
	};
};

export const actions = {
	estado: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const f = await request.formData();
		const r = await cambiarTrampa(u.correo, String(f.get('id')), f.get('activo') === 'si');
		if (r === 'hecho') return { mensaje: 'Hecho. El sensor lo aplica en su siguiente consulta.' };
		if (r === 'no-existe') return fail(404, { mensaje: 'Esa trampa no existe.' });
		if (r === 'no-se-para')
			return fail(400, {
				error: 'Lo que se pone a mano no se para: si ya no la quieres, retírala.'
			});
		return fail(400, { error: noSeParaPor(r.dependientes) });
	},
	retirar: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await retirarTrampa(u.correo, String((await request.formData()).get('id')));
		if (r === 'retirada') return { mensaje: 'Trampa retirada. Sus eventos se conservan.' };
		if (r === 'retirando')
			return {
				mensaje:
					'Ahora quítala de su destino: en «Pasos» tienes los de retirada. Cuando no quede nada, pulsa allí «Ya lo he quitado».'
			};
		if (r === 'no-existe') return fail(404, { mensaje: 'Esa trampa no existe.' });
		return fail(400, { error: recibeSenalDe(r.dependientes) });
	}
};
