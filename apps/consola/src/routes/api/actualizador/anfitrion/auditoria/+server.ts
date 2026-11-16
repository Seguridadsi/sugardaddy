import { error, json } from '@sveltejs/kit';
import { exigirActualizador } from '$lib/server/actualizador';
import { recibirAuditd } from '$lib/server/anfitrion';

/* Los eventos de auditd de la máquina (claves sd-*), a la auditoría (lib/server/anfitrion.ts). */
export const POST = async ({ request }) => {
	exigirActualizador(request);
	const n = await recibirAuditd(await request.json().catch(() => null));
	if (n === null) error(400, 'Expected { eventos: [...], omitidos }');
	return json({ ok: true, apuntados: n });
};
