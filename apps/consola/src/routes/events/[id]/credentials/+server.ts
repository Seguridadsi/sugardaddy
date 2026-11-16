import { error, json } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import { revelarDeEvento } from '$lib/server/credenciales';

/*
 * Revela las credenciales capturadas de un evento (en la línea van enmascaradas).
 * POST y no GET: que nada lo pida por adelantado ni lo guarde en una caché. Solo
 * con ver-credenciales; cada vez queda en la auditoría (revelarDeEvento).
 */
export const POST = async ({ params, locals }) => {
	const u = exigir(locals, 'ver-credenciales');
	if (!/^[0-9a-f-]{36}$/.test(params.id)) error(404);
	const r = await revelarDeEvento(u.correo, params.id);
	if (!r.ok)
		return json({ error: r.error }, { status: 409, headers: { 'cache-control': 'no-store' } });
	return json(
		{ contrasena: r.contrasena, campos: r.campos },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
