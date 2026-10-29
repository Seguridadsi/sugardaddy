import { env } from '$env/dynamic/private';
import { cabecera } from './consultas';
import { gestionado } from './actualizaciones';
import { urlPanelValida } from './canal';

/*
 * Lead de la edición community. Cuando la persona activa (o desactiva) la
 * auto-actualización —con el consentimiento para que SeguridadSI le escriba—,
 * el nodo manda su correo al panel de SeguridadSI, que lo guarda como lead.
 *
 * Solo tiene sentido en nodos SIN panel: los gestionados ya reportan por el
 * canal, así que ahí no se manda nada. Es best-effort: si el panel no responde,
 * la auto-actualización local queda igual y no se reintenta (el próximo cambio
 * del opt-in lo volvería a intentar).
 */

const PANEL = (env.SUGARDADDY_PANEL_URL ?? 'https://sugardaddy-central.azurewebsites.net').replace(
	/\/+$/,
	''
);

export async function enviarLead(accion: 'alta' | 'baja', correo: string) {
	if (await gestionado()) return;
	if (!urlPanelValida(PANEL)) return;

	let cuerpo: Record<string, unknown>;
	if (accion === 'baja') {
		cuerpo = { correo, baja: true };
	} else {
		const { nombre, nodo, version } = (await cabecera()).cliente;
		/* El panel fecha el consentimiento al recibir (no se manda la fecha: sería falsificable). */
		cuerpo = { correo, nombre, nodo, version };
	}

	try {
		await fetch(`${PANEL}/api/lead`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(cuerpo),
			signal: AbortSignal.timeout(10_000)
		});
	} catch {
		/* best-effort: el panel lo recogerá la próxima vez que cambie el opt-in */
	}
}
