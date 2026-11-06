import { fail, redirect } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import { ROLES } from '$lib/server/auth/permisos';
import {
	MIN_CLAVE,
	crear,
	fijarRoles,
	listar,
	loginLocalHabilitado,
	restablecer,
	retirar
} from '$lib/server/auth/local';

export const load = async ({ locals }) => {
	exigir(locals, 'ajustes');
	/* Si el nodo no admite login local, no hay nada que gestionar aquí. */
	if (!loginLocalHabilitado()) redirect(303, '/settings');
	return {
		roles: ROLES,
		minimo: MIN_CLAVE,
		usuarios: (await listar()).map((u) => ({
			...u,
			creada: u.creada.toISOString(),
			ultimoAcceso: u.ultimoAcceso?.toISOString() ?? null,
			bloqueadoHasta: u.bloqueadoHasta?.toISOString() ?? null
		}))
	};
};

/* El login local tiene que estar activo para tocar usuarios locales (no solo en el load). */
const apagado = () => fail(409, { error: 'Local sign-in is not enabled on this node.' });

export const actions = {
	crear: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		if (!loginLocalHabilitado()) return apagado();
		const f = await request.formData();
		const r = await crear(u.correo, {
			usuario: String(f.get('usuario') ?? ''),
			nombre: String(f.get('nombre') ?? ''),
			correo: String(f.get('correo') ?? ''),
			roles: f.getAll('rol').map(String),
			clave: String(f.get('clave') ?? '')
		});
		return r.ok
			? { mensaje: 'User created. They will have to change the password on first sign-in.' }
			: fail(400, { error: r.error });
	},
	restablecer: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const r = await restablecer(u.correo, String(f.get('id') ?? ''), String(f.get('clave') ?? ''));
		return r.ok
			? { mensaje: 'Password reset. The user will have to change it on next sign-in.' }
			: fail(400, { error: r.error });
	},
	roles: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const f = await request.formData();
		const r = await fijarRoles(u.correo, String(f.get('id') ?? ''), f.getAll('rol').map(String));
		return r.ok ? { mensaje: 'Roles updated.' } : fail(400, { error: r.error });
	},
	retirar: async ({ request, locals }) => {
		const u = exigir(locals, 'ajustes');
		const r = await retirar(u.correo, String((await request.formData()).get('id') ?? ''));
		return r.ok ? { mensaje: 'User removed.' } : fail(400, { error: r.error });
	}
};
