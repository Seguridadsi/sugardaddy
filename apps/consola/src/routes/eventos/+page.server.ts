import { fail } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import { puede } from '$lib/permisos';
import {
	ESTADOS_TRIAJE,
	SEVERIDADES,
	agruparEventos,
	etiquetasModulos,
	eventos,
	fijarTriaje,
	geoDe,
	nombresTrampas,
	quitarTriaje,
	totalEventos,
	type EstadoTriaje,
	type FiltroTriaje
} from '$lib/server/consultas';

/* El triaje pedido en la URL: uno de los tres, «sin» (sin triar) o nada (todos). */
const triajeDe = (v: string | null): FiltroTriaje | undefined =>
	v === 'sin' || (ESTADOS_TRIAJE as readonly string[]).includes(v ?? '')
		? (v as FiltroTriaje)
		: undefined;

/* Un UUID de verdad (v4/v8…), no solo 36 caracteres de hex y guiones: así un
 * valor con el formato raro da 400 limpio y no un 500 de Postgres. */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load = async ({ url, locals }) => {
	const pedida = url.searchParams.get('desde');
	const desde = SEVERIDADES.find((x) => x === pedida) ?? 'baja';
	const trampa = url.searchParams.get('trampa') ?? '';
	const origen = url.searchParams.get('origen')?.trim() ?? '';
	/* El usuario EXACTO (p. ej. desde el perfil de un usuario); sin trim, se guarda verbatim. */
	const usuario = url.searchParams.get('usuario') ?? '';
	const q = url.searchParams.get('q')?.trim() ?? '';
	const triaje = triajeDe(url.searchParams.get('triaje'));
	/* Agrupar eventos repetidos (misma IP, trampa y acción) en una fila con cuenta. */
	const agrupar = url.searchParams.get('agrupar') === '1';
	const nombres = await nombresTrampas();
	const lista = await eventos({
		desde,
		trampa: trampa || undefined,
		origen: origen || undefined,
		usuario: usuario || undefined,
		q: q || undefined,
		triaje
	});
	const vistos = agrupar ? agruparEventos(lista) : lista;

	return {
		ahora: Date.now(),
		eventos: vistos,
		agrupado: agrupar,
		/* Eventos traídos (antes de agrupar): el agrupado y el ×N son solo de estos. */
		cargados: lista.length,
		geos: await geoDe(lista),
		total: await totalEventos(),
		filtro: { desde, trampa, origen, usuario, q, triaje: triaje ?? '', agrupar },
		estadosTriaje: ESTADOS_TRIAJE,
		/* Solo quien puede triar (operador/admin) ve el control; a un lector no se
		 * le enseña un botón que luego daría 403. Con eventos agrupados no se triaja
		 * por evento (se marcaría el representante, no el grupo). */
		puedeTriar: !agrupar && !!locals.usuario && puede(locals.usuario.roles, 'desplegar'),
		/* El enlace a las reglas de triaje automático (su gestión es de operador). */
		puedeReglas: !!locals.usuario && puede(locals.usuario.roles, 'desplegar'),
		trampas: Object.entries(nombres).map(([id, nombre]) => ({ id, nombre })),
		nombres,
		modulos: etiquetasModulos()
	};
};

export const actions = {
	/* Marcar un evento (revisado / falso positivo / interesante) con una nota. */
	triaje: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const f = await request.formData();
		const evento = String(f.get('evento') ?? '');
		const estado = String(f.get('estado') ?? '');
		const nota = String(f.get('nota') ?? '');
		if (!ES_UUID.test(evento)) return fail(400, { error: 'Evento no válido.' });
		if (!(ESTADOS_TRIAJE as readonly string[]).includes(estado))
			return fail(400, { error: 'Estado de triaje no válido.' });
		const ok = await fijarTriaje(u.correo, evento, estado as EstadoTriaje, nota || null);
		if (!ok) return fail(404, { error: 'Ese evento ya no existe.' });
		return { mensaje: 'Triaje guardado.' };
	},
	/* Quitar el triaje de un evento (vuelve a «sin triar»). */
	quitarTriaje: async ({ request, locals }) => {
		const u = exigir(locals, 'desplegar');
		const evento = String((await request.formData()).get('evento') ?? '');
		if (!ES_UUID.test(evento)) return fail(400, { error: 'Evento no válido.' });
		await quitarTriaje(u.correo, evento);
		return { mensaje: 'Triaje retirado.' };
	}
};
