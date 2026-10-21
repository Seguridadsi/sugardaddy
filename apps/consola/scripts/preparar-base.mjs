/*
 * Lo que hace el arranque de la consola con la base de datos antes de
 * levantar el servidor (arrancar.mjs), aparte para poder probarlo:
 *
 *   1. aplica las migraciones pendientes;
 *   2. en el primer arranque, deja la identidad del nodo y su sensor local
 *      con lo que le pasa el instalador por entorno (nada de datos de ejemplo);
 *   3. da su destino a cada sensor que no lo tenga (el local en una
 *      instalación nueva, o los que dio de alta una consola anterior tras una
 *      vuelta atrás) y completa las trampas que dejó sin destino.
 */
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { completarDestinos } from './destinos.mjs';

/**
 * @param {import('postgres').Sql} conexion
 * @param {Record<string, string | undefined>} entorno
 * @param {string} [migraciones] la carpeta de las migraciones (en las pruebas, una copia recortada)
 */
export async function prepararBase(
	conexion,
	entorno,
	migraciones = new URL('../drizzle', import.meta.url).pathname
) {
	await migrate(drizzle(conexion), { migrationsFolder: migraciones });

	const { NODO_ID, NODO_NOMBRE, SENSOR_LOCAL_TOKEN } = entorno;
	if (NODO_ID && NODO_NOMBRE) {
		await conexion`insert into ajustes (clave, valor) values ('nodo', ${JSON.stringify({ nodo: NODO_ID, nombre: NODO_NOMBRE, version: entorno.SUGARDADDY_VERSION ?? '0.0.0' })}::jsonb) on conflict (clave) do nothing`;
	}
	if (SENSOR_LOCAL_TOKEN) {
		const hash = createHash('sha256').update(SENSOR_LOCAL_TOKEN).digest('hex');
		await conexion`insert into sensores (id, nombre, segmento, clave_hash) values ('local', 'Sensor local', 'el de este nodo', ${hash}) on conflict (id) do nothing`;
	}
	return completarDestinos(conexion);
}
