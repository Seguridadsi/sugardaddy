/*
 * La descarga de la exportación completa (lib/server/exportacion.ts). POST desde el
 * formulario de Ajustes → Export: la comprobación de origen de SvelteKit la cubre, y
 * un enlace de otra web no la dispara. Solo administradores del cliente, y nunca
 * desde una sesión de soporte de SeguridadSI: los datos salen para el cliente.
 */
import { error } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import { exportacionCompleta } from '$lib/server/exportacion';

export const POST = async ({ locals }) => {
	const u = exigir(locals, 'ajustes');
	if (u.soporte) error(403, 'A support session cannot export the customer data.');
	const cuerpo = await exportacionCompleta(u.correo);
	const sello = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
	return new Response(cuerpo, {
		headers: {
			'content-type': 'application/gzip',
			'content-disposition': `attachment; filename="sugardaddy-export-${sello}Z.tar.gz"`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
