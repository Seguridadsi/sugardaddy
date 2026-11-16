import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { leerHechos, paraElActualizador, recibirHechos } from '$lib/server/anfitrion';

/*
 * La máquina del nodo (lib/server/anfitrion.ts, docs/diseno/cortafuegos-anfitrion.md).
 * GET: qué tiene que dejar el cortafuegos estricto. POST: lo que el actualizador ve de
 * la máquina (SSH, auditd, Docker).
 */
export const GET = async ({ request }) => {
	exigirActualizador(request);
	return json(await paraElActualizador());
};

export const POST = async ({ request }) => {
	exigirActualizador(request);
	const h = leerHechos(await request.json().catch(() => null));
	if (!h) error(400, 'Expected { docker: { version, fijada, desfasada }, maquina? }');
	return json({ ok: true, cambios: await recibirHechos(h) });
};
