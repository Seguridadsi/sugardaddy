/*
 * La migración 0046: los sensores que ya existían siguen registrando lo de su
 * propia máquina, menos aquellos en los que alguien ya marcó o desmarcó la
 * casilla; los nuevos nacen sin registrarlo.
 *
 * Usa una base de datos de usar y tirar en el servidor de DATABASE_URL, como
 * migracion-destinos.spec.ts. Sin él, se salta.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL ?? '';
const MIGRACIONES = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/* Las migraciones hasta la que lleva ese prefijo (incluida): lo que había en un nodo con esa versión. */
function migracionesHasta(prefijo: string) {
	const carpeta = mkdtempSync(join(tmpdir(), 'sd-migraciones-'));
	const diario = JSON.parse(readFileSync(join(MIGRACIONES, 'meta/_journal.json'), 'utf8'));
	const hasta = diario.entries.findIndex((e: { tag: string }) => e.tag.startsWith(prefijo));
	expect(hasta).toBeGreaterThan(0);
	diario.entries = diario.entries.slice(0, hasta + 1);
	mkdirSync(join(carpeta, 'meta'));
	writeFileSync(join(carpeta, 'meta/_journal.json'), JSON.stringify(diario));
	for (const e of diario.entries)
		copyFileSync(join(MIGRACIONES, `${e.tag}.sql`), join(carpeta, `${e.tag}.sql`));
	return carpeta;
}

describe.skipIf(!url)('migración 0046: los sensores existentes siguen registrando lo suyo', () => {
	const nombre = `zz_prueba_${randomBytes(6).toString('hex')}`;
	let sql: postgres.Sql;

	beforeAll(async () => {
		const admin = postgres(url, { max: 1, onnotice: () => {} });
		await admin.unsafe(`create database ${nombre}`);
		await admin.end();
		const u = new URL(url);
		u.pathname = `/${nombre}`;
		sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
	});

	afterAll(async () => {
		await sql?.end();
		const admin = postgres(url, { max: 1, onnotice: () => {} });
		await admin.unsafe(`drop database if exists ${nombre} with (force)`);
		await admin.end();
	});

	const sensor = (id: string, registrar = false) =>
		sql`insert into "sensores" ("id", "nombre", "segmento", "clave_hash", "registrar_propio")
			values (${id}, ${`Sensor ${id}`}, 'pruebas', ${`x-${id}`}, ${registrar})`;
	const auditar = (accion: string, id: string) =>
		sql`insert into "auditoria" ("quien", "accion", "detalle") values ('kino', ${accion}, ${JSON.stringify({ id })}::jsonb)`;
	const registra = async (id: string) =>
		(await sql`select "registrar_propio" from "sensores" where "id" = ${id}`)[0]
			?.registrar_propio as boolean;

	it('sin tocar pasa a registrar; lo que alguien ya decidió se queda', async () => {
		await migrate(drizzle(sql), { migrationsFolder: migracionesHasta('0045') });
		// Como quedaron todos con la 0.24.2: sin registrar.
		await sensor('sin-tocar');
		await sensor('desmarcado');
		await auditar('sensor own-machine recording disabled', 'desmarcado');
		await sensor('marcado', true);
		await auditar('sensor own-machine recording enabled', 'marcado');
		// Lo de otro sensor u otra acción sobre este no cuenta como haberlo decidido.
		await sensor('otro-desmarcado');
		await auditar('sensor own-machine recording disabled', 'no-existe');
		await auditar('sensor renamed', 'otro-desmarcado');

		await migrate(drizzle(sql), { migrationsFolder: MIGRACIONES });

		expect(await registra('sin-tocar')).toBe(true);
		expect(await registra('otro-desmarcado')).toBe(true);
		expect(await registra('desmarcado')).toBe(false);
		expect(await registra('marcado')).toBe(true);
	});

	it('un sensor nuevo nace sin registrar lo de su máquina', async () => {
		await sql`insert into "sensores" ("id", "nombre", "segmento", "clave_hash")
			values ('nuevo', 'Sensor nuevo', 'pruebas', 'x-nuevo')`;
		expect(await registra('nuevo')).toBe(false);
	});
});
