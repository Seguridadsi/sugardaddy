import { error, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { rutaNueva } from '$lib/rutas-antiguas';
import { configuradoEnEntorno } from '$lib/server/auth/entra';
import { COOKIE_SESION, leer } from '$lib/server/auth/sesion';
import { altaAutomatica, latir } from '$lib/server/canal';
import { partnerAlDia } from '$lib/server/catalogo-partner';
import { renovar } from '$lib/server/registro';
import { purgar } from '$lib/server/conservacion';
import { rellenarSiHaceFalta } from '$lib/server/credenciales';
import { comprobarVersiones } from '$lib/server/actualizaciones';
import { enviarWebhookPendientes } from '$lib/server/webhook';
import {
	cortafuegosConfirma,
	cortafuegosReciente,
	leerAcceso,
	puedeEntrar
} from '$lib/server/acceso';
import { normalizarIp } from '$lib/server/pruebas';

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
	/* Cada hora, los eventos y la auditoría que pasan de su plazo de conservación. */
	const borrar = () => void purgar().catch((e) => console.error('[conservacion]', e));
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
};

/*
 * Lo único que se ve sin sesión: la entrada (normal y de emergencia) y las
 * API de los sensores, el actualizador y los firewalls, que se autentican
 * cada una con su token.
 */
const PUBLICO = [
	'/sign-in',
	'/auth/',
	'/emergency',
	'/api/sensor/',
	/* Lo pide curl desde la máquina de un sensor remoto; lo protege el código de un solo uso. */
	'/instalar-sensor/',
	'/api/actualizador/',
	'/api/salud',
	'/api/edl/',
	/* La raíz (pública) de la CA del nodo: hace falta antes de entrar sin avisos. */
	'/ca-raiz.crt'
];

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
		const acceso = await leerAcceso().catch(() => null);
		if (acceso?.estado === 'restringida') {
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
	const traiaSesion = !!event.cookies.get(COOKIE_SESION);
	const s = await leer(event.cookies);
	if (s)
		event.locals.usuario = {
			nombre: s.nombre,
			correo: s.correo,
			roles: s.roles,
			oid: s.oid,
			soporte: s.soporte,
			emergencia: s.emergencia
		};
	else if (!configuradoEnEntorno() && dev) {
		/* Sin Entra y en desarrollo: un usuario con todos los roles, y la barra lo dice. */
		event.locals.usuario = { nombre: 'Development', correo: 'dev@localhost', roles: ['admin'] };
		event.locals.modoDesarrollo = true;
	}

	const publico = PUBLICO.some((p) => event.url.pathname === p || event.url.pathname.startsWith(p));
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
	r.headers.set('X-Frame-Options', 'DENY');
	r.headers.set('X-Content-Type-Options', 'nosniff');
	r.headers.set('Referrer-Policy', 'same-origin');
	r.headers.set('X-Robots-Tag', 'noindex, nofollow');
	r.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	if (event.url.protocol === 'https:')
		r.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	return r;
};
