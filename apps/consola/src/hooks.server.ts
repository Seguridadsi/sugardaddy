import { error, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { configurado } from '$lib/server/auth/entra';
import { leer } from '$lib/server/auth/sesion';
import { altaAutomatica, considerarCommunity, latir } from '$lib/server/canal';
import { purgar } from '$lib/server/conservacion';
import { rellenarSiHaceFalta } from '$lib/server/credenciales';
import { comprobarActualizacion } from '$lib/server/actualizaciones';
import { enviarWebhookPendientes } from '$lib/server/webhook';

/*
 * El latido hacia el panel central sale del servidor de la consola, no del
 * navegador: late aunque nadie tenga la consola abierta.
 */
const CADA = Number(env.LATIDO_SEGUNDOS ?? 60) * 1000;
export const init: ServerInit = () => {
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
		void comprobarActualizacion().catch((e) => console.error('[actualizaciones]', e));
		/* Community opted-in: baja la release firmada y, si toca, la deja pendiente. */
		void considerarCommunity().catch((e) => console.error('[auto-actualización]', e));
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
	'/entrar',
	'/auth/',
	'/emergencia',
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
	event.locals.usuario = null;
	event.locals.modoDesarrollo = false;

	/*
	 * La sesión se lee siempre, también sin Entra configurado: así la llave de
	 * emergencia sirve justo cuando Entra no está.
	 */
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
	else if (!configurado() && dev) {
		/* Sin Entra y en desarrollo: un usuario con todos los roles, y la barra lo dice. */
		event.locals.usuario = { nombre: 'Desarrollo', correo: 'dev@localhost', roles: ['admin'] };
		event.locals.modoDesarrollo = true;
	}

	const publico = PUBLICO.some((p) => event.url.pathname === p || event.url.pathname.startsWith(p));
	if (!publico && !event.locals.usuario) {
		if (event.request.method !== 'GET') error(401, 'Hay que entrar primero');
		redirect(303, `/entrar?volverA=${encodeURIComponent(event.url.pathname + event.url.search)}`);
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
