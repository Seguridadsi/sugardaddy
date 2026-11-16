import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { recibirEstricto } from '$lib/server/anfitrion';

/* Cómo ha quedado el cortafuegos estricto de la máquina (lib/server/anfitrion.ts). */
export const POST = async ({ request }) => {
	exigirActualizador(request);
	if (!(await recibirEstricto(await request.json().catch(() => null))))
		error(400, 'Expected { estado, detalle, huella }');
	return json({ ok: true });
};
