import { fail } from '@sveltejs/kit';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import { exigir } from '$lib/server/auth/permisos';
import { catalogoConSuscripcion } from '$lib/server/catalogo';
import { cambiarTrampa, retirarTrampa } from '$lib/server/gestion';
import { trampasConEventos } from '$lib/server/consultas';
import { noSeParaPor, recibeSenalDe } from '$lib/formato';
import { nombresDePlantillas, plantillasDisponibles } from '$lib/server/plantillas';
import { silenciosPorObjeto } from '$lib/server/alcance-ficha';
import { DIAS_RUIDO, ruidoPorTrampa } from '$lib/server/ruido';

/*
 * Las trampas ya puestas. El catálogo para añadir nuevas vive en /decoys/catalog.
 *
 * Cada desplegada lleva la procedencia de su módulo y su tipo de servicio: la
 * lista pone con ellos su icono (iconoTrampa), el logotipo del honeypot en que
 * se basa, el pictograma de su tipo o la abeja. Una desplegada de un módulo que
 * ya no está en el catálogo va sin procedencia, con el pictograma de su tipo si
 * lo tiene; por eso se consulta el catálogo aunque aquí no se liste.
 */
export const load = async ({ url }) => {
	const catalogo = await catalogoConSuscripcion();
	const procedencias = new Map(catalogo.map((m) => [m.id, m.procedencia ?? null]));
	const desplegados = await trampasConEventos();
	/* El grupo de cada una: la plantilla de la que salió; una ya borrada se queda con su id. */
	const nombres: Record<string, string> = desplegados.some((t) => t.plantilla)
		? await nombresDePlantillas()
		: {};
	const grupos = [...new Set(desplegados.flatMap((t) => (t.plantilla ? [t.plantilla] : [])))]
		.map((id) => ({ id, nombre: nombres[id] ?? id }))
		.toSorted((a, b) => a.nombre.localeCompare(b.nombre, 'en'));
	/* Por qué salidas de avisos no sale lo de cada una (lib/alcance.ts). */
	const silencios = (await silenciosPorObjeto()).trampas;
	const pedida = url.searchParams.get('template');
	return {
		/* Las plantillas son de Cloud: en Community no se ofrecen. */
		conPlantillas: plantillasDisponibles(),
		grupos,
		/* ?template: solo las de esa plantilla, si alguna trampa la lleva. */
		plantilla: grupos.some((g) => g.id === pedida) ? pedida : null,
		/* La métrica de ruido (lib/ruido.ts): solo se calcula en su pestaña. */
		ruido:
			url.searchParams.get('tab') === 'noise'
				? { dias: DIAS_RUIDO, trampas: await ruidoPorTrampa() }
				: null,
		creado: url.searchParams.get('creado'),
		cambiado: url.searchParams.get('cambiado'),
		quitada: url.searchParams.get('quitada'),
		desplegados: desplegados.map((t) => ({
			...t,
			plantillaNombre: t.plantilla ? (nombres[t.plantilla] ?? t.plantilla) : null,
			procedencia: procedencias.get(t.modulo) ?? null,
			pictograma: tipoDeServicio(t.modulo),
			silencios: silencios[t.id] ?? []
		}))
	};
};

export const actions = {
	estado: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const f = await request.formData();
		const r = await cambiarTrampa(u.correo, String(f.get('id')), f.get('activo') === 'si');
		if (r === 'hecho') return { mensaje: 'Done. The sensor applies it on its next check-in.' };
		if (r === 'no-existe') return fail(404, { mensaje: 'That honeypot does not exist.' });
		if (r === 'no-se-para')
			return fail(400, {
				error: 'A manually deployed honeypot cannot be paused. If you no longer want it, remove it.'
			});
		return fail(400, { error: noSeParaPor(r.dependientes) });
	},
	retirar: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const r = await retirarTrampa(u.correo, String((await request.formData()).get('id')));
		if (r === 'retirada') return { mensaje: 'Honeypot removed. Its events are kept.' };
		if (r === 'retirando')
			return {
				mensaje:
					'Now remove it from its target: the removal instructions are under "Steps". When nothing is left, click "I have removed it" there.'
			};
		if (r === 'no-existe') return fail(404, { mensaje: 'That honeypot does not exist.' });
		return fail(400, { error: recibeSenalDe(r.dependientes) });
	},
	/* Retirar todas las de una plantilla (retirarVarias). */
	retirarGrupo: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const plantilla = String((await request.formData()).get('plantilla') ?? '');
		if (!plantillasDisponibles())
			return fail(404, { error: 'Templates are included in Sugardaddy Cloud.' });
		const suyas = (await trampasConEventos()).filter(
			(t) => t.plantilla === plantilla && t.colocacion !== 'retirando'
		);
		if (!suyas.length) return fail(404, { error: 'No honeypot from that template is deployed.' });
		return { mensaje: await retirarVarias(u.correo, suyas) };
	},
	/*
	 * Retirar las elegidas en la lista, de una vez: para vaciar un sensor (que no
	 * se puede quitar mientras le quede alguna) ya no hay que repetirlo por cada
	 * una. Por el mismo camino y con el mismo orden que las de una plantilla.
	 */
	retirarElegidas: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const ids = new Set((await request.formData()).getAll('id').map(String));
		const suyas = (await trampasConEventos()).filter(
			(t) => ids.has(t.id) && t.colocacion !== 'retirando'
		);
		if (!suyas.length) return fail(404, { error: 'None of the selected honeypots is deployed.' });
		return { mensaje: await retirarVarias(u.correo, suyas) };
	}
};

/*
 * Retira varias, una a una y por el camino de siempre, y dice qué ha pasado
 * con todas en un solo mensaje. Primero las sembradas a mano y después las
 * demás: una credencial que apunta a una trampa de la lista se retira antes que
 * ella. La que no se puede (algo de fuera apunta a ella) se queda, y se dice.
 */
async function retirarVarias(
	quien: string,
	trampas: { id: string; nombre: string; aMano: boolean }[]
): Promise<string> {
	let retiradas = 0;
	let aMano = 0;
	const quedan: string[] = [];
	for (const t of trampas.toSorted((a, b) => Number(b.aMano) - Number(a.aMano))) {
		const r = await retirarTrampa(quien, t.id);
		if (r === 'retirada') retiradas++;
		else if (r === 'retirando') aMano++;
		else if (r !== 'no-existe') quedan.push(t.nombre);
	}
	const partes = [
		`${retiradas} ${retiradas === 1 ? 'honeypot' : 'honeypots'} removed. Their events are kept.`,
		...(aMano
			? [
					`${aMano} must now be removed from ${aMano === 1 ? 'its target' : 'their targets'}: the removal instructions are under "Steps" on each one.`
				]
			: []),
		...(quedan.length
			? [`Not removed because another honeypot points to them: ${quedan.join(', ')}.`]
			: [])
	];
	return partes.join(' ');
}
