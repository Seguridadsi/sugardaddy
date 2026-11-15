import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { guardarEstadoMarca, leerEstadoMarca, marcaDelPanel } from '$lib/server/canal';

/*
 * La marca de tiempo (docs/diseno/firmas-raiz.md). GET: la que repartió el panel, tal cual,
 * para que el actualizador la compruebe con sus claves y la compare con la copia estática.
 * POST: lo que el actualizador ha concluido, que va al aviso de la consola y al latido.
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	return json({ marca: await marcaDelPanel() });
};

export const POST = async ({ request }) => {
	exigirActualizador(request);
	const e = leerEstadoMarca(await request.json().catch(() => null));
	if (!e) error(400, 'Expected { estado, detalle, ultima, caduca, origen }');
	await guardarEstadoMarca(e);
	return json({ ok: true });
};
