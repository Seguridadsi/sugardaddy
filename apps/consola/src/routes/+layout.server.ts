import { actualizacionDisponible, cabecera } from '$lib/server/consultas';
import { hayGeo } from '$lib/server/geo';
import { soporte } from '$lib/server/soporte';
import { logo } from '$lib/server/canal';

/* Sin sesión (la pantalla de entrada) no se consulta nada: ni el nombre del cliente se enseña. */
export const load = async ({ locals }) =>
	locals.usuario
		? {
				usuario: locals.usuario,
				modoDesarrollo: locals.modoDesarrollo,
				soporte: await soporte(),
				logo: (await logo())?.huella.slice(0, 12) ?? null,
				geo: hayGeo(),
				actualizacion: await actualizacionDisponible(),
				...(await cabecera())
			}
		: {
				usuario: null,
				modoDesarrollo: false,
				soporte: null,
				logo: null,
				geo: false,
				actualizacion: { version: null },
				cliente: null,
				pendientes: 0
			};
