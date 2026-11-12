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
import {
	buscarActualizaciones,
	cabecera,
	guardarActualizacionDisponible,
	guardarComprobacionVersion,
	type ComprobacionVersion
} from './consultas';
import { considerarCommunity, gestionadoPorPanel } from './canal';
import { avisarContacto } from './registro';

/* «Gestionado» = dado de alta en un panel (hay Canal), NO «tiene clave»: un nodo
 * community tiene la clave pública para verificar pero no tiene panel. Se reexpone
 * como gestionado para Ajustes y el layout. */
export { gestionadoPorPanel as gestionado };

const URL_VERSION =
	env.ACTUALIZACIONES_URL ??
	'https://raw.githubusercontent.com/Seguridadsi/sugardaddy/main/despliegue/nodo/VERSION';

const SEMVER = /^\d+\.\d+\.\d+$/;

/* Qué versión hay publicada, o null si no se pudo leer; 'no-aplica' si este nodo no la mira. */
export async function comprobarActualizacion(): Promise<string | null | 'no-aplica'> {
	if (
		(await gestionadoPorPanel()) ||
		env.BUSCAR_ACTUALIZACIONES === '0' ||
		!(await buscarActualizaciones())
	) {
		await guardarActualizacionDisponible(null);
		return 'no-aplica';
	}
	try {
		const res = await fetch(URL_VERSION, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return null;
		const remota = (await res.text()).trim();
		const actual = (await cabecera()).cliente.version;
		if (!SEMVER.test(remota) || !SEMVER.test(actual)) return null;
		await guardarActualizacionDisponible(compararVersiones(remota, actual) > 0 ? remota : null);
		return remota;
	} catch {
		/* Sin red o GitHub caído: se deja como estaba, sin romper nada. */
		return null;
	}
}

/*
 * Las dos miradas de un nodo sin panel, juntas: el aviso de versión nueva y, si la
 * actualización automática está activa, la versión firmada. Deja apuntado cuándo se miró
 * y qué se vio, para que Ajustes lo enseñe; lo llaman el reloj de cada 6 horas y el botón
 * «Check now». Un nodo con panel no apunta nada: sus versiones le llegan por ahí.
 */
export async function comprobarVersiones(ahora = new Date()): Promise<ComprobacionVersion | null> {
	const aviso = await comprobarActualizacion();
	const firmada = await considerarCommunity();
	/* Registrado y con actualización automática: el panel sabe que sigue vivo y en qué versión. */
	await avisarContacto().catch(() => 'sin-conexion');
	if (aviso === 'no-aplica' && firmada.visto === 'no-aplica') return null;
	const leida = 'version' in firmada ? firmada.version : null;
	const valor: ComprobacionVersion = {
		cuando: ahora.toISOString(),
		red:
			leida !== null || firmada.visto === 'rechazada' || (aviso !== null && aviso !== 'no-aplica'),
		/* La firmada manda: es la que este nodo instalaría. Sin ella, la del aviso. */
		version: leida ?? (aviso !== 'no-aplica' ? aviso : null),
		rechazada: firmada.visto === 'rechazada' ? firmada.motivo : null
	};
	await guardarComprobacionVersion(valor);
	return valor;
}
