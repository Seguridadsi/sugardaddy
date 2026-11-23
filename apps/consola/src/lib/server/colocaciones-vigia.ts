/*
 * Cada minuto (hooks.server.ts): las trampas sembradas cuya caducidad ha pasado se retiran
 * (D7) y los conectores hacen lo suyo (colocar lo pendiente, retirar, rotar y comprobar,
 * conector-ficheros.ts). Una de pasos a mano que caduca pasa a «retirando» con sus pasos de
 * retirada: la consola no puede quitarla sola, y lo dice en su ficha y en Placements.
 */
import { EJECUTORES } from '@sugardaddy/contrato';
import { trampasCaducadas } from './colocaciones';
import { retirarPorConector, vigilarConectores } from './conector-ficheros';
import { retirarTrampa } from './gestion';

/* Quién firma en la auditoría la retirada por caducidad. */
export const QUIEN_CADUCIDAD = 'sugardaddy (expiry)';

export async function vigilarColocaciones(): Promise<void> {
	for (const t of await trampasCaducadas()) {
		const r = await retirarTrampa(QUIEN_CADUCIDAD, t.id);
		if (r === 'retirando-conector' || EJECUTORES[t.ejecutor]?.clase === 'conector')
			await retirarPorConector(t.id, QUIEN_CADUCIDAD).catch(() => undefined);
	}
	await vigilarConectores();
}
