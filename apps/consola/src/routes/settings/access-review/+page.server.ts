import { fail } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import {
	confirmarRevision,
	cuentas,
	desactivar,
	diasInactividad,
	estadoRevision,
	fijarDiasInactividad,
	reactivar,
	revisiones
} from '$lib/server/revision-accesos';
import {
	DIAS_INACTIVIDAD_MAXIMO,
	DIAS_INACTIVIDAD_MINIMO,
	diasValidos,
	origenCuenta,
	referencia
} from '$lib/revision-accesos';

/*
 * Revisión de accesos (plan de fortificación §4.6): quién puede entrar en esta
 * consola y cuándo entró por última vez, la confirmación de cada trimestre y el
 * plazo de inactividad tras el que una cuenta se desactiva sola.
 */
export const load = async ({ locals }) => {
	exigir(locals, 'ajustes');
	const dias = await diasInactividad();
	const ahora = Date.now();
	return {
		dias,
		minimo: DIAS_INACTIVIDAD_MINIMO,
		maximo: DIAS_INACTIVIDAD_MAXIMO,
		estado: await estadoRevision(ahora),
		cuentas: (await cuentas()).map((c) => ({
			oid: c.oid,
			correo: c.correo,
			nombre: c.nombre,
			roles: c.roles,
			origen: origenCuenta(c.oid),
			ultimaEntrada: c.ultimaEntrada?.toISOString() ?? null,
			/* Cuándo se desactivará sola si no entra (las activas). */
			caduca: c.desactivada ? null : new Date(referencia(c) + dias * 86_400_000).toISOString(),
			desactivada: c.desactivada?.toISOString() ?? null,
			desactivadaPor: c.desactivadaPor,
			motivo: c.motivo
		})),
		revisiones: (await revisiones()).map((r) => ({
			id: r.id,
			cuando: r.cuando.toISOString(),
			quien: r.quien,
			nota: r.nota,
			cuentas: r.usuarios.length,
			activas: r.usuarios.filter((u) => u.activa).length
		}))
	};
};

const oidDe = async (request: Request) => String((await request.formData()).get('oid') ?? '');

export const actions = {
	confirmar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const nota = String((await request.formData()).get('nota') ?? '');
		await confirmarRevision(u.correo, nota);
		return { mensaje: 'Access review recorded. The next one is due in three months.' };
	},
	desactivar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const oid = await oidDe(request);
		if (oid === u.oid) return fail(400, { error: 'You cannot disable your own account.' });
		const r = await desactivar(u.correo, oid);
		return r.ok ? { mensaje: 'Account disabled and its sessions closed.' } : fail(400, r);
	},
	reactivar: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const r = await reactivar(u.correo, await oidDe(request));
		return r.ok ? { mensaje: 'Account enabled.' } : fail(400, r);
	},
	dias: async ({ locals, request }) => {
		const u = exigir(locals, 'ajustes');
		const dias = diasValidos((await request.formData()).get('dias'));
		if (!dias)
			return fail(400, {
				error: `Choose between ${DIAS_INACTIVIDAD_MINIMO} and ${DIAS_INACTIVIDAD_MAXIMO} days.`
			});
		await fijarDiasInactividad(u.correo, dias);
		return { mensaje: `Accounts are disabled after ${dias} days without signing in.` };
	}
};
