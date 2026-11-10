import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { informeDelNodo, paraElActualizador } from '$lib/server/ca-nodo';

/*
 * La CA propia del nodo (docs/diseno/ca-nodo.md): el actualizador pregunta si
 * el administrador ha confirmado la raíz preparada y cuenta en qué CA está el
 * HTTPS de la consola y cómo fue el cambio.
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	return json(await paraElActualizador());
};

export const POST = async ({ request }) => {
	exigirActualizador(request);
	const b = await request.json().catch(() => null);
	if (!(await informeDelNodo(b)))
		error(400, 'Expected { modo, raiz, huella, direccion, resultado }');
	return json({ ok: true });
};
