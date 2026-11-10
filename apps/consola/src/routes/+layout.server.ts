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
import { redirect } from '@sveltejs/kit';
import { puede } from '$lib/permisos';
import { cortafuegos, cortafuegosConfirma, leerAcceso } from '$lib/server/acceso';
import { avisoCa } from '$lib/server/ca-nodo';

/*
 * El acceso a la consola por IP (docs/diseno/acceso-consola.md): sin decidir,
 * quien puede decidirlo va a esa pantalla antes que a ninguna otra.
 */
async function acceso(usuario: App.Locals['usuario'], ruta: string) {
	const a = await leerAcceso();
	const admin = !!usuario && puede(usuario.roles, 'ajustes');
	if (admin && a.estado === 'pendiente' && !ruta.startsWith('/settings/access'))
		redirect(303, '/settings/access');
	return {
		estado: a.estado,
		emergencia: !!a.emergencia,
		/* Limitada en la consola, pero el cortafuegos de la máquina no confirma que aplique esta lista. */
		cortafuegosMal: a.estado === 'restringida' && !cortafuegosConfirma(a, await cortafuegos())
	};
}

/* Sin sesión (la pantalla de entrada) no se consulta nada: ni el nombre del cliente se enseña. */
export const load = async ({ locals, url, cookies }) =>
	locals.usuario
		? {
				acceso: await acceso(locals.usuario, url.pathname),
				/* La raíz nueva del HTTPS de la consola (docs/diseno/ca-nodo.md), solo para quien decide. */
				ca: await avisoCa(puede(locals.usuario.roles, 'ajustes')),
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
				acceso: { estado: 'restringida' as const, emergencia: false, cortafuegosMal: false },
				ca: null,
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
