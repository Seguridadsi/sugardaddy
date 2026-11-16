import { exigir } from '$lib/server/auth/permisos';
import { auditoria } from '$lib/server/gestion';
import { grabaciones } from '$lib/server/soporte-registro';

/*
 * Dos pestañas: la auditoría entera y lo grabado de las sesiones de soporte de
 * SeguridadSI (soporte-registro.ts), cada petición con quién y qué respondió.
 */
export const load = async ({ locals, url }) => {
	exigir(locals, 'ajustes');
	const enSoporte = url.searchParams.get('tab') === 'support';
	const q = enSoporte ? '' : (url.searchParams.get('q') ?? '');
	return {
		q,
		filas: enSoporte ? [] : await auditoria(q),
		soporte: enSoporte
			? (await grabaciones()).map((x) => ({ ...x, cuando: x.cuando.toISOString() }))
			: []
	};
};
