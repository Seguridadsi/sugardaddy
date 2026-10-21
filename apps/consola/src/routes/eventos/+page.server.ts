import {
	SEVERIDADES,
	etiquetasModulos,
	geoDe,
	nombresTrampas,
	totalEventos,
	eventos
} from '$lib/server/consultas';

export const load = async ({ url }) => {
	const pedida = url.searchParams.get('desde');
	const desde = SEVERIDADES.find((x) => x === pedida) ?? 'baja';
	const trampa = url.searchParams.get('trampa') ?? '';
	const origen = url.searchParams.get('origen')?.trim() ?? '';
	const nombres = await nombresTrampas();
	const lista = await eventos({
		desde,
		trampa: trampa || undefined,
		origen: origen || undefined
	});

	return {
		ahora: Date.now(),
		eventos: lista,
		geos: await geoDe(lista),
		total: await totalEventos(),
		filtro: { desde, trampa, origen },
		trampas: Object.entries(nombres).map(([id, nombre]) => ({ id, nombre })),
		nombres,
		modulos: etiquetasModulos()
	};
};
