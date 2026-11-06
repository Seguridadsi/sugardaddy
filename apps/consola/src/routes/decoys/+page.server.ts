import { fail } from '@sveltejs/kit';
import { tipoEvento } from '@sugardaddy/contrato';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { exigir } from '$lib/server/auth/permisos';
import { catalogoConSuscripcion, desplegable, porQueNo } from '$lib/server/catalogo';
import { cambiarTrampa, retirarTrampa } from '$lib/server/gestion';
import { trampasConEventos } from '$lib/server/consultas';
import { noSeParaPor, recibeSenalDe } from '$lib/formato';

/*
 * Cada trampa, desplegada o del catálogo, lleva la procedencia de su módulo y
 * su tipo de servicio: la lista pone con ellos su icono (iconoTrampa), el
 * logotipo del honeypot en que se basa, el pictograma de su tipo o la abeja.
 * Una desplegada de un módulo que ya no está en el catálogo va sin
 * procedencia, con el pictograma de su tipo si lo tiene.
 *
 * El catálogo va con las instaladas delante, luego las disponibles (en la suscripción y, si son de
 * pago, en la licencia) y, dentro de cada grupo, por nombre.
 */
export const load = async ({ url }) => {
	const catalogo = await catalogoConSuscripcion();
	const procedencias = new Map(catalogo.map((m) => [m.id, m.procedencia ?? null]));
	const desplegados = await trampasConEventos();
	/* Cuántas trampas hay puestas de cada módulo: el catálogo marca las que ya están en uso. */
	const instaladas = new Map<string, number>();
	for (const t of desplegados) instaladas.set(t.modulo, (instaladas.get(t.modulo) ?? 0) + 1);
	return {
		creado: url.searchParams.get('creado'),
		cambiado: url.searchParams.get('cambiado'),
		quitada: url.searchParams.get('quitada'),
		desplegados: desplegados.map((t) => ({
			...t,
			procedencia: procedencias.get(t.modulo) ?? null,
			pictograma: tipoDeServicio(t.modulo)
		})),
		catalogo: catalogo
			.toSorted(
				(a, b) =>
					Number(instaladas.has(b.id)) - Number(instaladas.has(a.id)) ||
					Number(b.disponible) - Number(a.disponible) ||
					a.nombre.localeCompare(b.nombre, 'en')
			)
			.map((m) => ({
				id: m.id,
				nombre: m.nombre,
				tipo: tipoEvento(m),
				disponible: m.disponible,
				instaladas: instaladas.get(m.id) ?? 0,
				porQueNo: porQueNo(m),
				activarConRegistro: !m.disponible && m.conRegistro,
				registroCaducado: m.licencia === 'registro.caducado',
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
		if (r === 'hecho') return { mensaje: 'Done. The sensor applies it on its next check-in.' };
		if (r === 'no-existe') return fail(404, { mensaje: 'That decoy does not exist.' });
		if (r === 'no-se-para')
			return fail(400, {
				error: 'A manually deployed decoy cannot be paused. If you no longer want it, remove it.'
			});
		return fail(400, { error: noSeParaPor(r.dependientes) });
	},
	retirar: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await retirarTrampa(u.correo, String((await request.formData()).get('id')));
		if (r === 'retirada') return { mensaje: 'Decoy removed. Its events are kept.' };
		if (r === 'retirando')
			return {
				mensaje:
					'Now remove it from its target: the removal instructions are under "Steps". When nothing is left, click "I have removed it" there.'
			};
		if (r === 'no-existe') return fail(404, { mensaje: 'That decoy does not exist.' });
		return fail(400, { error: recibeSenalDe(r.dependientes) });
	}
};
