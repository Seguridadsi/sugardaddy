import { error } from '@sveltejs/kit';
import { exigir } from '$lib/server/auth/permisos';
import { leerCaNodo } from '$lib/server/ca-nodo';

/*
 * La raíz nueva que ha preparado el nodo (docs/diseno/ca-nodo.md), para
 * instalarla en los equipos antes de cambiar. Es pública, pero solo la
 * necesita quien la reparte: va con sesión y rol de ajustes.
 */
export const GET = async ({ locals }) => {
	exigir(locals, 'ajustes');
	const ca = await leerCaNodo();
	if (ca?.modo !== 'caddy' || !ca.raiz || ca.error)
		error(404, 'There is no new root waiting on this node.');
	return new Response(ca.raiz, {
		headers: {
			'content-type': 'application/x-x509-ca-cert',
			'content-disposition': 'attachment; filename="sugardaddy-console-root.crt"',
			'cache-control': 'no-store'
		}
	});
};
