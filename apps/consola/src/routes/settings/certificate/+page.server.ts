import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { exigir } from '$lib/server/auth/permisos';
import {
	aprobarCambio,
	huellaDe,
	leerCaNodo,
	nombreDe,
	raizActiva,
	sensoresSinRaizNueva
} from '$lib/server/ca-nodo';
import { nombreConsola } from '$lib/server/direccion-consola';
import { normalizarIp } from '$lib/server/pruebas';

/*
 * Por dónde entra quien mira y para qué nombre es el certificado. El certificado
 * del nodo solo vale para la dirección de la consola: quien entra por otra (su
 * IP, casi siempre) ve el aviso del navegador aunque instale la raíz, y lo
 * vuelve a ver cada vez que Caddy renueva el certificado (dura 12 horas). No es
 * un fallo que se pueda quitar desde aquí: se dice, con lo que sí lo quita.
 */
function entrada(anfitrion: string) {
	const nombre = nombreConsola();
	if (!nombre || anfitrion.toLowerCase() === nombre.toLowerCase()) return null;
	return { por: anfitrion, nombre, ip: normalizarIp(anfitrion) };
}

/* La raíz del HTTPS de la consola y el paso a la CA propia del nodo (docs/diseno/ca-nodo.md). */
export const load = async ({ locals, url }) => {
	exigir(locals, 'ajustes');
	const ca = await leerCaNodo();
	const activa = raizActiva();
	const pendiente = ca?.modo === 'caddy' && ca.raiz && !ca.error ? ca.raiz : null;
	return {
		ficheros: env.TLS_MODO === 'ficheros' || ca?.modo === 'ficheros',
		/* null: entra por el nombre del certificado. */
		entrada: entrada(url.hostname),
		modo: ca?.modo ?? null,
		direccion: ca?.direccion ?? (env.ORIGIN ? new URL(env.ORIGIN).hostname : null),
		error: ca?.error ?? null,
		informado: ca?.informado ?? null,
		activa: activa ? { huella: huellaDe(activa), nombre: nombreDe(activa) } : null,
		nueva: pendiente ? { huella: ca!.huella, nombre: nombreDe(pendiente) } : null,
		aprobada: ca?.aprobada ?? null,
		resultado: ca?.resultado ?? null,
		anterior: ca?.anterior ?? null,
		sensores: pendiente ? await sensoresSinRaizNueva() : []
	};
};

export const actions = {
	confirmar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		if (f.get('instalada') !== 'si')
			return fail(400, {
				error: 'Confirm that the new root is installed on the computers that open the console.'
			});
		const r = await aprobarCambio(
			u.correo,
			String(f.get('huella') ?? ''),
			f.get('cortarSensores') === 'si'
		);
		if (!r.ok) return fail(400, { error: r.error });
		redirect(303, '/settings/certificate?confirmada=1');
	}
};
