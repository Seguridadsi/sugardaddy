import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { guardarInforme, paraElActualizador } from '$lib/server/copias-fuera';

/*
 * Las copias del nodo, fuera de la máquina (docs/diseno/copias-fuera.md): el
 * actualizador pregunta adónde subirlas (con la credencial descifrada: solo por
 * esta puerta local y con su token) y cuenta lo que ha hecho.
 */
export const GET = async ({ request }) => {
	/*
	 * La credencial solo sale por la red interna (consola:3000), nunca por Caddy,
	 * que siempre pone X-Forwarded-For: ni con el token se da desde fuera.
	 */
	if (request.headers.has('x-forwarded-for')) error(404, 'Not found');
	exigirActualizador(request);
	return json(await paraElActualizador(), { headers: { 'cache-control': 'no-store' } });
};

export const POST = async ({ request }) => {
	exigirActualizador(request);
	const b = await request.json().catch(() => null);
	if (!b || typeof b !== 'object' || Array.isArray(b)) error(400, 'Expected a JSON object');
	await guardarInforme(b as Record<string, unknown>);
	return json({ ok: true });
};
