import { error } from '@sveltejs/kit';
import { etapa1DelNodo } from '$lib/server/sensores-remotos';

/*
 * La primera etapa del instalador de Cloud, tal como va en la versión firmada del nodo
 * (docs/diseno/instalador-verificado.md, «Sensor remoto»). Pública: es la misma para
 * todos y la línea comprueba su sha256 antes de ejecutarla.
 */
export const GET = async () => {
	const e = await etapa1DelNodo();
	if (!e) error(404, 'This console does not serve the verified installer');
	return new Response(e.texto, {
		headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' }
	});
};
