import { error, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { configurado } from '$lib/server/auth/entra';
import { leer } from '$lib/server/auth/sesion';
import { altaAutomatica, latir } from '$lib/server/canal';
import { rellenarSiHaceFalta } from '$lib/server/credenciales';

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
