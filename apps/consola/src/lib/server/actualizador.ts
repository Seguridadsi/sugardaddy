/*
 * La puerta local del actualizador: el proceso aparte que tiene el socket de
 * Docker y cambia las imágenes. La consola nunca toca Docker; solo le dice qué
 * versión firmada toca y apunta cómo ha ido.
 */
import { timingSafeEqual } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export function exigirActualizador(request: Request) {
	const esperado = env.ACTUALIZADOR_TOKEN;
	if (!esperado || esperado.length < 32)
		error(503, 'El actualizador no está configurado en este nodo');
	const dado = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
	const a = Buffer.from(dado);
	const b = Buffer.from(esperado);
	if (a.length !== b.length || !timingSafeEqual(a, b))
		error(401, 'Token del actualizador no válido');
}
