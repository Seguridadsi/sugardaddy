import { exigir } from '$lib/server/auth/permisos';
import { auditoria } from '$lib/server/gestion';

export const load = async ({ locals, url }) => {
	exigir(locals, 'ajustes');
	const q = url.searchParams.get('q') ?? '';
	return { q, filas: await auditoria(q) };
};
