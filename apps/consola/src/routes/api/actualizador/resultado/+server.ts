import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { resultadoActualizacion } from '$lib/server/canal';

export const POST = async ({ request }) => {
	exigirActualizador(request);
	const b = await request.json().catch(() => null);
	const estado = b?.estado;
	if (typeof b?.version !== 'string' || !['aplicando', 'aplicada', 'fallida'].includes(estado))
		error(400, 'Se esperaba { version, estado, detalle }');
	const tipo = b.tipo === 'configuracion' ? 'configuracion' : 'version';
	const ok = await resultadoActualizacion(b.version, estado, String(b.detalle ?? ''), tipo);
	if (!ok) error(409, 'Esa versión no es la pendiente');
	return json({ ok: true });
};
