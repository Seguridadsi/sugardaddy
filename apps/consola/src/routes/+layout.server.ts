import { avisoAnfitrion } from '$lib/server/anfitrion';
import { actualizacionDisponible, autoActualizar, cabecera } from '$lib/server/consultas';
import { actualizacion as actualizacionPendiente } from '$lib/server/canal';
import { esperaActual } from '$lib/server/politica-actualizacion';
import { hayGeo } from '$lib/server/geo';
import { porCaducar, posturaSoporte, soporte } from '$lib/server/soporte';
import { estadoRevision } from '$lib/server/revision-accesos';
import { estadoB2B } from '$lib/server/auth/b2b';
import { estadoEntraPropio } from '$lib/server/auth/entra-propio';
import { estadoMarca, logo } from '$lib/server/canal';
import { pentestActivo } from '$lib/server/pentest-activo';
import { mantenimientoActivo } from '$lib/server/mantenimiento';
import { esCommunity } from '$lib/server/edicion';
import { OPERADOR_POR_DEFECTO, operador } from '$lib/server/operador';
import { zonasDe } from '$lib/server/zona-horaria';
import { redirect } from '@sveltejs/kit';
import { puede } from '$lib/permisos';
import {
	cortafuegos,
	cortafuegosAplicando,
	cortafuegosConfirma,
	leerAcceso
} from '$lib/server/acceso';
import { avisoCa } from '$lib/server/ca-nodo';
import { resumenConfiguracion } from '$lib/server/configuracion-inicial';
import { avisoPartnerFuera } from '$lib/server/catalogo-partner';

/*
 * El acceso a la consola por IP (docs/diseno/acceso-consola.md): sin decidir,
 * quien puede decidirlo va a esa pantalla antes que a ninguna otra.
 */
async function acceso(usuario: App.Locals['usuario'], ruta: string) {
	const a = await leerAcceso();
	const c = a.estado === 'restringida' ? await cortafuegos() : null;
	const admin = !!usuario && puede(usuario.roles, 'ajustes');
	if (admin && a.estado === 'pendiente' && !ruta.startsWith('/settings/access'))
		redirect(303, '/settings/access');
	return {
		estado: a.estado,
		emergencia: !!a.emergencia,
		/*
		 * Limitada en la consola, pero el cortafuegos de la máquina no confirma que
		 * aplique esta lista. No cuenta el rato en que la está aplicando tras un cambio
		 * (añadir la IP de un sensor remoto, guardar la lista): eso no es un fallo.
		 */
		cortafuegosMal:
			a.estado === 'restringida' && !cortafuegosConfirma(a, c) && !cortafuegosAplicando(a, c),
		/* Por qué: lo dijo el cortafuegos (no puede, o falló) o no hay noticias del actualizador. */
		cortafuegosMotivo:
			c && (c.estado === 'sin-docker-user' || c.estado === 'error')
				? c.estado
				: ('sin-noticias' as const)
	};
}

/*
 * La configuración inicial (/setup): a quien administra una consola recién instalada se
 * le lleva una vez, al llegar al inicio; después le queda el enlace en el menú hasta que
 * termina. Va detrás del acceso por IP, que redirige antes desde cualquier ruta.
 */
async function configuracion(usuario: App.Locals['usuario'], ruta: string) {
	if (!usuario || !puede(usuario.roles, 'ajustes')) return { pendiente: false };
	const c = await resumenConfiguracion();
	if (c.llevar && ruta === '/') redirect(303, '/setup');
	return { pendiente: c.pendiente };
}

/* Sin sesión (la pantalla de entrada) no se consulta nada: ni el nombre del cliente se enseña. */
export const load = async ({ locals, url, cookies }) =>
	locals.usuario
		? {
				acceso: await acceso(locals.usuario, url.pathname),
				configuracion: await configuracion(locals.usuario, url.pathname),
				/* La raíz nueva del HTTPS de la consola (docs/diseno/ca-nodo.md), solo para quien decide. */
				ca: await avisoCa(puede(locals.usuario.roles, 'ajustes')),
				/* La marca de tiempo (docs/diseno/firmas-raiz.md): solo si hay algo que decir. */
				marca: await (async () => {
					const m = await estadoMarca();
					return m && (m.estado === 'caducada' || m.estado === 'retenida' || m.registro) ? m : null;
				})(),
				...(await zonasDe(locals.usuario, cookies)),
				usuario: locals.usuario,
				modoDesarrollo: locals.modoDesarrollo,
				...(await (async () => {
					const sop = await soporte();
					const postura = await posturaSoporte();
					return {
						soporte: sop,
						soportePorCaducar: porCaducar(sop, Date.now(), postura),
						soporteBanca: postura === 'banca'
					};
				})()),
				/* La revisión trimestral de accesos, vencida: solo la ve quien la hace (revision-accesos.ts). */
				revisionVencida:
					puede(locals.usuario.roles, 'ajustes') &&
					(await estadoRevision().then(
						(e) => e.vencida,
						() => false
					)),
				/* Aún entra por el Entra de SeguridadSI: se avisa a quien puede migrarlo (b2b.ts). */
				b2b: puede(locals.usuario.roles, 'ajustes') ? await estadoB2B() : 'no',
				/* Entra propio de antes de exigir MFA: se avisa hasta activarla (entra-propio.ts). */
				entraSinMfa:
					puede(locals.usuario.roles, 'ajustes') &&
					(await estadoEntraPropio().then(
						(e) => !!e?.activo && e.modoMfa === 'heredada',
						() => false
					)),
				operador: await operador(),
				logo: (await logo())?.huella.slice(0, 12) ?? null,
				geo: hayGeo(),
				actualizacion: await actualizacionDisponible(),
				autoActualizar: await autoActualizar(),
				community: esCommunity(),
				/* Docker por detrás de la versión firmada y el cortafuegos estricto que no queda (anfitrion.ts). */
				anfitrion: puede(locals.usuario.roles, 'ajustes')
					? await avisoAnfitrion().catch(() => null)
					: null,
				/* Una versión que espera su aprobación (política de cambios manual): solo la ve quien aprueba. */
				versionPorAprobar: puede(locals.usuario.roles, 'ajustes')
					? await (async () => {
							const a = await actualizacionPendiente();
							return (await esperaActual(a)).motivo === 'aprobacion' ? a.version : null;
						})()
					: null,
				pentest: await pentestActivo(),
				/* Una ventana de mantenimiento en curso: la salud de lo que cubre no avisa. */
				mantenimiento: await mantenimientoActivo(),
				/* Las trampas de un partner cuyo certificado caducó o se retiró: paradas (catalogo-partner.ts). */
				partnerFuera: await avisoPartnerFuera(),
				...(await cabecera())
			}
		: {
				acceso: {
					estado: 'restringida' as const,
					emergencia: false,
					cortafuegosMal: false,
					cortafuegosMotivo: 'sin-noticias' as const
				},
				configuracion: { pendiente: false },
				ca: null,
				marca: null,
				...(await zonasDe(null, cookies)),
				usuario: null,
				modoDesarrollo: false,
				soporte: null,
				soportePorCaducar: false,
				soporteBanca: false,
				revisionVencida: false,
				b2b: 'no' as const,
				entraSinMfa: false,
				operador: OPERADOR_POR_DEFECTO,
				logo: null,
				geo: false,
				actualizacion: { version: null },
				autoActualizar: { decidido: true, activo: false, correo: null, consentimiento: null },
				community: false,
				anfitrion: null,
				versionPorAprobar: null,
				pentest: null,
				mantenimiento: null,
				partnerFuera: null,
				cliente: null,
				pendientes: 0
			};
