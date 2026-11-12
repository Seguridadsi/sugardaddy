import { necesitaAtencion } from '$lib/server/atencion';
import { etiquetasModulos, geoDe, resumen } from '$lib/server/consultas';

export const load = async () => {
	const r = await resumen();
	return {
		...r,
		modulos: etiquetasModulos(),
		geos: await geoDe(r.ultimos),
		/* Lo roto o a medias del propio despliegue, en una sola lista. */
		atencion: await necesitaAtencion()
	};
};
