import { error, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { rutaNueva } from '$lib/rutas-antiguas';
import { esPublica } from '$lib/rutas-publicas';
import { configuradoEnEntorno } from '$lib/server/auth/entra';
import { leer, traeSesion } from '$lib/server/auth/sesion';
import { altaAutomatica, latir } from '$lib/server/canal';
import { partnerAlDia } from '$lib/server/catalogo-partner';
import { renovar } from '$lib/server/registro';
import { purgar } from '$lib/server/conservacion';
import { sellar } from '$lib/server/auditoria-cadena';
import { rellenarSiHaceFalta } from '$lib/server/credenciales';
import { comprobarVersiones } from '$lib/server/actualizaciones';
import { enviarWebhookPendientes } from '$lib/server/webhook';
import {
	cortafuegosConfirma,
	cortafuegosReciente,
	accesoParaFiltrar,
	puedeEntrar
} from '$lib/server/acceso';
import { normalizarIp } from '$lib/server/pruebas';
import { ponerCabeceras } from '$lib/server/cabeceras';
import { csrfRechaza } from '$lib/server/csrf';
import { vigilarSoporte } from '$lib/server/soporte';
import { vigilarMantenimiento } from '$lib/server/mantenimiento';
import { vigilarColocaciones } from '$lib/server/colocaciones-vigia';
import { grabar } from '$lib/server/soporte-registro';
import { desactivarInactivas } from '$lib/server/revision-accesos';
import { separacionCredenciales } from '$lib/server/banca';
import { separarCredenciales } from '$lib/permisos';

/*
 * El latido hacia el panel central sale del servidor de la consola, no del
 * navegador: late aunque nadie tenga la consola abierta.
 */
const CADA = Number(env.LATIDO_SEGUNDOS ?? 60) * 1000;
export const init: ServerInit = () => {
	/*
	 * Las trampas del partner de este nodo, en memoria desde el arranque y al día cada
	 * minuto (su certificado caduca): el catálogo se lee sin esperar a la base.
	 */
	const cp = globalThis as { __partner?: ReturnType<typeof setInterval> };
	clearInterval(cp.__partner);
	const partner = () => void partnerAlDia().catch((e) => console.error('[partner]', e));
	partner();
	cp.__partner = setInterval(partner, 60_000);
	const g = globalThis as { __latido?: ReturnType<typeof setInterval> };
	if (g.__latido) clearInterval(g.__latido);
	g.__latido = setInterval(() => void latir(), CADA);
	g.__latido.unref?.();
	/* Primer arranque tras el instalador: alta en el panel, con reintentos. */
	const intentar = async (n: number) => {
		if (!(await altaAutomatica().catch(() => false)) && n < 40)
			setTimeout(() => void intentar(n + 1), 30_000);
	};
	void intentar(0);
	/* Los eventos de antes de esta versión no tenían la contraseña aparte. */
	void rellenarSiHaceFalta().catch((e) => console.error('[credenciales]', e));
	/*
	 * Cada hora, los eventos y la auditoría que pasan de su plazo de conservación y,
	 * después, el sello de la cabeza de la auditoría (auditoria-cadena.ts).
	 */
	const borrar = () =>
		void purgar()
			.catch((e) => console.error('[conservacion]', e))
			.then(() => sellar())
			.catch((e) => console.error('[auditoria] seal', e));
	const h = globalThis as { __conservacion?: ReturnType<typeof setInterval> };
	if (h.__conservacion) clearInterval(h.__conservacion);
	h.__conservacion = setInterval(borrar, 60 * 60_000);
	h.__conservacion.unref?.();
	borrar();
	/* Aviso de versión nueva (solo nodos sin gestión): mira el repo público cada tanto. */
	const comprobar = () => {
		/* Y, en Community con actualización automática, la versión firmada: si toca, queda pendiente. */
		void comprobarVersiones().catch((e) => console.error('[actualizaciones]', e));
		/* Registro de Community: renueva su licencia cuando le toca. Falla cerrado y aparte. */
		void renovar().catch((e) => console.error('[registro]', e));
	};
	const a = globalThis as { __actualizaciones?: ReturnType<typeof setInterval> };
	if (a.__actualizaciones) clearInterval(a.__actualizaciones);
	a.__actualizaciones = setInterval(comprobar, 6 * 60 * 60_000);
	a.__actualizaciones.unref?.();
	setTimeout(comprobar, 20_000);
	/* Webhook de eventos: cada medio minuto, dispara los nuevos a la URL del
	 * cliente si está activo (best-effort; la fiabilidad la pone él). */
	const enviarWebhook = () =>
		void enviarWebhookPendientes().catch((e) => console.error('[webhook]', e));
	const w = globalThis as { __webhook?: ReturnType<typeof setInterval> };
	if (w.__webhook) clearInterval(w.__webhook);
	w.__webhook = setInterval(enviarWebhook, 30_000);
	w.__webhook.unref?.();
	/*
	 * Inventario de colocaciones (D7): cada minuto, retirar lo caducado y, con un conector
	 * (SharePoint y OneDrive, D3), colocar, retirar, rotar y comprobar lo suyo.
	 */
	const colocaciones = () =>
		void vigilarColocaciones().catch((e) => console.error('[colocaciones]', e));
	const col = globalThis as { __colocaciones?: ReturnType<typeof setInterval> };
	if (col.__colocaciones) clearInterval(col.__colocaciones);
	col.__colocaciones = setInterval(colocaciones, 60_000);
	col.__colocaciones.unref?.();
	/* Ventanas de mantenimiento: cada minuto, el aviso de las que empiezan y el resumen de las que acaban. */
	const mant = () => void vigilarMantenimiento().catch((e) => console.error('[mantenimiento]', e));
	const mt = globalThis as { __mantenimiento?: ReturnType<typeof setInterval> };
	if (mt.__mantenimiento) clearInterval(mt.__mantenimiento);
	mt.__mantenimiento = setInterval(mant, 60_000);
	mt.__mantenimiento.unref?.();
	/* El acceso de soporte se cierra solo al caducar, aunque nadie tenga la consola abierta. */
	const sop = () => void vigilarSoporte().catch((e) => console.error('[soporte]', e));
	const so = globalThis as { __soporte?: ReturnType<typeof setInterval> };
	if (so.__soporte) clearInterval(so.__soporte);
	so.__soporte = setInterval(sop, 60_000);
	so.__soporte.unref?.();
	/* Revisión de accesos: cada hora, las cuentas que pasan del plazo sin entrar se desactivan. */
	const inactivas = () =>
		void desactivarInactivas().catch((e) => console.error('[revision-accesos]', e));
	const ra = globalThis as { __revisionAccesos?: ReturnType<typeof setInterval> };
	if (ra.__revisionAccesos) clearInterval(ra.__revisionAccesos);
	ra.__revisionAccesos = setInterval(inactivas, 60 * 60_000);
	ra.__revisionAccesos.unref?.();
	setTimeout(inactivas, 2 * 60_000).unref?.();
};

export const handle: Handle = async ({ event, resolve }) => {
	/*
	 * Acceso por IP (docs/diseno/acceso-consola.md). El cortafuegos de la
	 * máquina ya tira lo que no está en la lista; esto es la segunda barrera,
	 * por si no pudo. Solo mira lo que llega por Caddy, que siempre pone
	 * X-Forwarded-For: el sensor local y el actualizador hablan directamente con
	 * consola:3000, por la red interna. Fuera de la lista, un 404 vacío. Va antes
	 * que nada, también que las rutas antiguas, para no dar pistas. Los ficheros
	 * estáticos los sirve adapter-node antes de llegar aquí: ese límite queda
	 * dicho en docs/diseno/acceso-consola.md.
	 */
	if (event.request.headers.has('x-forwarded-for')) {
		/* Sin base, cerrada: lo último conocido o la red de la máquina (accesoParaFiltrar). */
		const acceso = await accesoParaFiltrar();
		if (acceso.estado === 'restringida') {
			let ip: string | null = null;
			try {
				ip = normalizarIp(event.getClientAddress());
			} catch {
				ip = null;
			}
			const confirmado = cortafuegosConfirma(acceso, await cortafuegosReciente().catch(() => null));
			if (!puedeEntrar(ip, acceso, confirmado)) return new Response(null, { status: 404 });
		}
	}

	/*
	 * Formularios de otro origen (CSRF): lo que hacía SvelteKit, aquí para dejar
	 * pasar solo el ACS de SAML (csrf.ts). Como SvelteKit, no en desarrollo.
	 */
	if (!dev && csrfRechaza(event.request, event.url)) {
		const message = `Cross-site ${event.request.method} form submissions are forbidden`;
		return event.request.headers.get('accept') === 'application/json'
			? new Response(JSON.stringify({ message }), {
					status: 403,
					headers: { 'content-type': 'application/json' }
				})
			: new Response(message, { status: 403 });
	}

	/*
	 * Rutas que empiezan por «//»: un 404. Es el arreglo provisional que da
	 * GHSA-pfhg-q3qv-9q6r (redirección abierta con use:enhance) hasta SvelteKit 3;
	 * la excepción está en osv-scanner.toml.
	 */
	if (event.url.pathname.startsWith('//')) return new Response(null, { status: 404 });
	/* 308: una ruta de antes del paso a inglés (rutas-antiguas.ts), con su método y su cuerpo. */
	const nueva = rutaNueva(event.url.pathname);
	if (nueva)
		return new Response(null, {
			status: 308,
			headers: { location: nueva + event.url.search }
		});

	event.locals.usuario = null;
	event.locals.modoDesarrollo = false;

	/*
	 * La sesión se lee siempre, también sin Entra configurado: así la llave de
	 * emergencia sirve justo cuando Entra no está.
	 */
	/* Traía una sesión: si ya no vale, al volver a la entrada se le dice por qué está ahí. */
	const traiaSesion = traeSesion(event.cookies);
	const s = await leer(event.cookies);
	if (s)
		event.locals.usuario = {
			nombre: s.nombre,
			correo: s.correo,
			/* Perfil bancario: quien administra no revela credenciales (lib/server/banca.ts). */
			roles: (await separacionCredenciales()) ? separarCredenciales(s.roles) : s.roles,
			oid: s.oid,
			soporte: s.soporte,
			emergencia: s.emergencia,
			sesion: s.sesion
		};
	else if (!configuradoEnEntorno() && dev) {
		/* Sin Entra y en desarrollo: un usuario con todos los roles, y la barra lo dice. */
		event.locals.usuario = { nombre: 'Development', correo: 'dev@localhost', roles: ['admin'] };
		event.locals.modoDesarrollo = true;
	}

	const publico = esPublica(event.url.pathname);
	if (!publico && !event.locals.usuario) {
		if (event.request.method !== 'GET')
			error(
				401,
				traiaSesion
					? 'Your session has ended (it closes after a period without activity). Reload the page and sign in again.'
					: 'Sign in first'
			);
		redirect(
			303,
			`/sign-in?volverA=${encodeURIComponent(event.url.pathname + event.url.search)}${traiaSesion ? '&caducada' : ''}`
		);
	}

	const r = await resolve(event);
	ponerCabeceras(r.headers);
	/*
	 * Lo que hace el soporte de SeguridadSI queda grabado (soporte-registro.ts). Si
	 * la grabación falla, la petición ya se hizo: queda en el registro de errores.
	 */
	const u = event.locals.usuario;
	if (u?.soporte)
		await grabar({
			quien: u.correo,
			sesion: u.sesion ?? null,
			metodo: event.request.method,
			url: event.url,
			estado: r.status
		}).catch((e) => console.error('[soporte] recording', e));
	return r;
};
