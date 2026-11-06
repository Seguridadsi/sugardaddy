import { error, fail } from '@sveltejs/kit';
import { isIP } from 'node:net';
import { exigir } from '$lib/server/auth/permisos';
import { anadirALista, etiquetasModulos, nombresTrampas, perfilDeIp } from '$lib/server/consultas';
import { migrados, origenDe } from '$lib/server/origenes-comun';

export const load = async ({ params }) => {
	/* SvelteKit ya entrega el parámetro decodificado; no se vuelve a decodificar. */
	const ip = params.ip.trim();
	const perfil = await perfilDeIp(ip);
	if (!perfil) error(404, 'There are no events for that IP.');
	return {
		ahora: Date.now(),
		ip,
		...perfil,
		nombres: await nombresTrampas(),
		modulos: etiquetasModulos(),
		/* «Es mío» solo donde hay Orígenes conocidos (no en community). */
		origenes: !!(await migrados()),
		conocido: isIP(ip) ? await origenDe(ip) : null
	};
};

export const actions = {
	/*
	 * Mete esta IP en la lista negra LOCAL, lo que «Qué hacer ahora» ya aconseja
	 * en texto. Esa lista alimenta el EDL (/api/edl/negra) que leen los firewalls,
	 * así que el bloqueo se propaga sin pasos extra. Caducidad opcional (días),
	 * igual que en Listas; reusa anadirALista (no la modifica).
	 */
	bloquear: async ({ params, request, locals }) => {
		const u = exigir(locals, 'listas');
		const ip = params.ip.trim();
		/* Nunca la IP del propio motor de contenedores: no es la de un atacante. */
		if (!isIP(ip)) return fail(400, { error: 'Not a valid IP address.' });
		const perfil = await perfilDeIp(ip);
		if (perfil?.oculta)
			return fail(400, { error: "This is the container engine IP, not an attacker's." });
		const dias = Number((await request.formData()).get('dias') ?? 0);
		const nuevo = await anadirALista(u.correo, {
			valor: ip,
			clase: 'ip',
			lista: 'negra',
			motivo: 'blocked from the IP profile',
			caduca: dias > 0 ? new Date(Date.now() + dias * 86_400_000) : null
		});
		return nuevo ? { bloqueada: ip } : { yaEstaba: true };
	}
};
