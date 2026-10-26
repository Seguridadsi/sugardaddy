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
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
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

	await sembrarAdmin(conexion, entorno);

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

/**
 * Hash scrypt de una contraseña, en el MISMO formato que
 * src/lib/server/auth/local.ts (scrypt$N$r$p$sal$hash). Si cambia allí, cámbialo
 * aquí: lo fija una prueba (auth/local.spec.ts).
 * @param {string} clave
 */
function hashClaveLocal(clave) {
	const N = 1 << 15;
	const sal = randomBytes(16);
	const h = scryptSync(clave, sal, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
	return `scrypt$${N}$8$1$${sal.toString('base64')}$${h.toString('base64')}`;
}

/**
 * Primer arranque con login local activo (LOGIN_LOCAL=1 o EDICION=community) y
 * sin ningún usuario local todavía: se crea un administrador «admin» con una
 * contraseña de un solo uso que se imprime aquí (y solo aquí). La consola obliga
 * a cambiarla al entrar. Si ya hay usuarios, no se toca nada.
 * @param {import('postgres').Sql} conexion
 * @param {Record<string, string | undefined>} entorno
 */
async function sembrarAdmin(conexion, entorno) {
	if (!(entorno.LOGIN_LOCAL === '1' || entorno.EDICION === 'community')) return;
	const [{ hay }] = await conexion`select exists(select 1 from usuarios_locales) as hay`;
	if (hay) return;
	const clave = randomBytes(12).toString('base64url');
	await conexion`insert into usuarios_locales (id, usuario, nombre, correo, clave_hash, roles, debe_cambiar, creada_por)
		values (${randomUUID()}, 'admin', 'Administrador', 'admin@local', ${hashClaveLocal(clave)}, ${JSON.stringify(['admin'])}::jsonb, true, 'instalador')`;
	await conexion`insert into auditoria (quien, accion, detalle) values ('instalador', 'primer administrador local creado', ${JSON.stringify({ usuario: 'admin' })}::jsonb)`;
	const barra = '='.repeat(60);
	console.log(
		`\n${barra}\n  PRIMER ADMINISTRADOR DE LA CONSOLA (login local)\n` +
			`  Usuario:     admin\n  Contraseña:  ${clave}\n` +
			`  De un solo uso: la consola te la hará cambiar al entrar.\n${barra}\n`
	);
}
