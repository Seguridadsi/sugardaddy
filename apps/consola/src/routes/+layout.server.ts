import { actualizacionDisponible, autoActualizar, cabecera } from '$lib/server/consultas';
import { gestionado } from '$lib/server/actualizaciones';
import { hayGeo } from '$lib/server/geo';
import { soporte } from '$lib/server/soporte';
import { logo } from '$lib/server/canal';
import { pentestActivo } from '$lib/server/pentest-activo';
import { identidad } from '$lib/server/identidad';
import { esCommunity } from '$lib/server/edicion';
import { OPERADOR_POR_DEFECTO, operador } from '$lib/server/operador';
import { sugerirDominio } from '$lib/camuflaje';
import { zonasDe } from '$lib/server/zona-horaria';

/* Sin sesión (la pantalla de entrada) no se consulta nada: ni el nombre del cliente se enseña. */
export const load = async ({ locals, url, cookies }) =>
	locals.usuario
		? {
				...(await zonasDe(locals.usuario, cookies)),
				usuario: locals.usuario,
				modoDesarrollo: locals.modoDesarrollo,
				soporte: await soporte(),
				operador: await operador(),
				logo: (await logo())?.huella.slice(0, 12) ?? null,
				geo: hayGeo(),
				actualizacion: await actualizacionDisponible(),
				autoActualizar: await autoActualizar(),
				gestionado: await gestionado(),
				community: esCommunity(),
				pentest: await pentestActivo(),
				/* Solo esto: la semilla no sale del servidor. */
				identidad: { decidido: (await identidad()).decidido },
				dominioSugerido: sugerirDominio(url.hostname),
				...(await cabecera())
			}
		: {
				...(await zonasDe(null, cookies)),
				usuario: null,
				modoDesarrollo: false,
				soporte: null,
				operador: OPERADOR_POR_DEFECTO,
				logo: null,
				geo: false,
				actualizacion: { version: null },
				autoActualizar: { decidido: true, activo: false, correo: null, consentimiento: null },
				gestionado: true,
				community: false,
				pentest: null,
				identidad: { decidido: true },
				dominioSugerido: '',
				cliente: null,
				pendientes: 0
			};
