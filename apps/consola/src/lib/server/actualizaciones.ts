/*
 * Aviso de versión nueva para nodos SIN gestión (build local / edición gratis):
 * no reciben actualizaciones firmadas del panel, así que la consola mira de vez
 * en cuando el fichero de versión del repositorio público y, si hay una mayor,
 * lo deja apuntado para enseñar un aviso. Best-effort: si no hay red, no pasa
 * nada. Un nodo gestionado (dado de alta en un panel) se actualiza por ahí y
 * esto no corre. No instala nada: solo avisa; actualizar lo decide la persona.
 */
import { env } from '$env/dynamic/private';
import { compararVersiones } from '@sugardaddy/canal';
import { buscarActualizaciones, cabecera, guardarActualizacionDisponible } from './consultas';
import { gestionadoPorPanel } from './canal';

/* «Gestionado» = dado de alta en un panel (hay Canal), NO «tiene clave»: un nodo
 * community tiene la clave pública para verificar pero no tiene panel. Se reexpone
 * como gestionado para Ajustes y el layout. */
export { gestionadoPorPanel as gestionado };

const URL_VERSION =
	env.ACTUALIZACIONES_URL ??
	'https://raw.githubusercontent.com/Seguridadsi/sugardaddy/main/despliegue/nodo/VERSION';

const SEMVER = /^\d+\.\d+\.\d+$/;

export async function comprobarActualizacion() {
	if (
		(await gestionadoPorPanel()) ||
		env.BUSCAR_ACTUALIZACIONES === '0' ||
		!(await buscarActualizaciones())
	) {
		await guardarActualizacionDisponible(null);
		return;
	}
	try {
		const res = await fetch(URL_VERSION, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return;
		const remota = (await res.text()).trim();
		const actual = (await cabecera()).cliente.version;
		if (!SEMVER.test(remota) || !SEMVER.test(actual)) return;
		await guardarActualizacionDisponible(compararVersiones(remota, actual) > 0 ? remota : null);
	} catch {
		/* Sin red o GitHub caído: se deja como estaba, sin romper nada. */
	}
}
