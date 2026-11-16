/*
 * El perfil bancario de la consola (plan de fortificación §4.3, §4.4): un botón
 * en Ajustes → General que deja de una vez las tres cosas que pide un banco, y
 * que se pueden cambiar después una a una:
 *
 * 1. la política de actualización: aprobación manual y 72 horas de retardo
 *    (politica-actualizacion.ts);
 * 2. el soporte de SeguridadSI justo a tiempo: cada petición aprobada, 4 horas
 *    como mucho, sin renovar y cerrado al salir (soporte.ts);
 * 3. la separación de funciones con las credenciales: un administrador no
 *    revela credenciales capturadas aunque tenga el rol `credenciales`
 *    (lib/permisos.ts → separarCredenciales, aplicado en hooks.server.ts);
 * 4. el cortafuegos estricto de la máquina (anfitrion.ts), que el perfil deja
 *    encendido aunque ya lo estuviera de serie.
 *
 * Cada cambio queda en la auditoría con quién lo hizo.
 */
import { eq } from 'drizzle-orm';
import { db, schema as s } from './db';
import { auditar } from './consultas';
import { esBanca, POLITICA_BANCA } from '$lib/politica-actualizacion';
import { guardarPoliticaActualizacion, politicaActualizacion } from './politica-actualizacion';
import { fijarPosturaSoporte, posturaSoporte } from './soporte';

const CLAVE = 'separacion-credenciales';
type Ajuste = { activa: boolean; por: string; cuando: string };

/*
 * Se lee en cada petición (hooks.server.ts): en memoria unos segundos. Al
 * cambiarla desde esta consola se refresca en el acto; desde otro proceso, como
 * mucho en CACHE_MS.
 */
const CACHE_MS = 10_000;
let cache: { activa: boolean; hasta: number } | null = null;

export async function separacionCredenciales(ahora = Date.now()): Promise<boolean> {
	if (cache && cache.hasta > ahora) return cache.activa;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	const activa = (f?.valor as Ajuste | undefined)?.activa === true;
	cache = { activa, hasta: ahora + CACHE_MS };
	return activa;
}

export async function fijarSeparacion(quien: string, activa: boolean) {
	cache = null;
	if ((await separacionCredenciales()) === activa) return false;
	const valor: Ajuste = { activa, por: quien, cuando: new Date().toISOString() };
	await db
		.insert(s.ajustes)
		.values({ clave: CLAVE, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
	cache = null;
	await auditar(
		quien,
		activa
			? 'credential role separation turned on: administrators cannot reveal credentials'
			: 'credential role separation turned off',
		{ activa }
	);
	return true;
}

export async function estadoBanca() {
	const [politica, soporte, separacion] = await Promise.all([
		politicaActualizacion(),
		posturaSoporte(),
		separacionCredenciales(0)
	]);
	const partes = {
		politica: esBanca(politica),
		soporte: soporte === 'banca',
		separacion
	};
	return { ...partes, completo: partes.politica && partes.soporte && partes.separacion };
}

/* El botón: las tres a la vez. Devuelve cuáles ha cambiado. */
export async function aplicarPerfilBanca(quien: string) {
	const antes = await estadoBanca();
	const cambios: string[] = [];
	if (!antes.politica && (await guardarPoliticaActualizacion(quien, POLITICA_BANCA)))
		cambios.push('update policy');
	if (await fijarPosturaSoporte(quien, 'banca')) cambios.push('support access');
	if (await fijarSeparacion(quien, true)) cambios.push('credential role separation');
	/* El cortafuegos estricto de la máquina (anfitrion.ts). Import dinámico: anfitrion lee estadoBanca. */
	if (await (await import('./anfitrion')).encenderEstricto(quien))
		cambios.push('strict host firewall');
	if (cambios.length) await auditar(quien, 'banking profile applied', { cambios });
	return cambios;
}
