import { etiquetasModulos, geoDe, resumen } from '$lib/server/consultas';

export const load = async () => {
	const r = await resumen();
	return { ...r, modulos: etiquetasModulos(), geos: await geoDe(r.ultimos) };
};
