/*
 * La migración 0012_destinos sobre los datos de una 0011, lo que sigue
 * haciendo la consola anterior con el esquema nuevo, también con la 0013 (el
 * actualizador vuelve a ella sin restaurar la base de datos) y el arranque
 * (preparar-base.mjs).
 *
 * Cada caso usa una base de datos de usar y tirar, creada y borrada en el
 * servidor de DATABASE_URL (la de .env, como recepcion.spec.ts). Si no hay,
 * esa parte se salta; lo que no necesita base de datos corre siempre.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANDIDATOS, idDestino, slugDestino } from '../../../scripts/destinos.mjs';
import { prepararBase } from '../../../scripts/preparar-base.mjs';

let url = '';
try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
	url = process.env.DATABASE_URL ?? '';
} catch {
	url = '';
}

const CONSOLA = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRACIONES = join(CONSOLA, 'drizzle');

/* Una base de datos vacía en el mismo servidor, con su conexión. Se borra en afterAll. */
async function baseTemporal() {
	const nombre = `zz_prueba_${randomBytes(6).toString('hex')}`;
	const admin = postgres(url, { max: 1, onnotice: () => {} });
	await admin.unsafe(`create database ${nombre}`);
	await admin.end();
	const u = new URL(url);
	u.pathname = `/${nombre}`;
	const sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
	const borrar = async () => {
		await sql.end();
		const a = postgres(url, { max: 1, onnotice: () => {} });
		await a.unsafe(`drop database if exists ${nombre} with (force)`);
		await a.end();
	};
	return { sql, borrar };
}

/* Las migraciones hasta la que lleva ese prefijo (incluida), copiadas aparte: lo que había en un nodo con esa versión. */
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

/* Lo que manda la consola anterior al dar de alta una trampa: sin las columnas de la 0012. */
const insertarComoAntes = (
	sql: postgres.Sql,
	t: { id: string; sensor: string; donde?: string; activo?: boolean; creado?: string }
) =>
	sql`insert into "trampas" ("id", "nombre", "modulo", "tipo", "sensor", "donde", "parametros", "activo", "creado")
		values (${t.id}, ${t.id}, 'cowrie', 'contenedor', ${t.sensor}, ${t.donde ?? 'desplegando…'}, '{}'::jsonb,
			${t.activo ?? true}, ${t.creado ?? new Date().toISOString()})`;

const sensorComoAntes = (sql: postgres.Sql, id: string, creado = new Date().toISOString()) =>
	sql`insert into "sensores" ("id", "nombre", "segmento", "clave_hash", "creado")
		values (${id}, ${`Sensor ${id}`}, 'pruebas', ${`x-${id}`}, ${creado})`;

/*
 * drizzle cambia los lectores de fechas de la conexión que recibe (la del
 * migrador), y entonces llegan como texto: se comparan como ISO.
 */
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

let n = 0;
const evento = (sql: postgres.Sql, sensor: string, trampa: string, recibido: string) => {
	n++;
	return sql`insert into "eventos" ("id", "sensor", "linea", "hash", "cuando", "trampa", "modulo", "tipo",
			"accion", "severidad", "conexion_establecida", "recibido")
		values (${`2b0e0000-0000-4000-8000-${String(n).padStart(12, '0')}`}, ${sensor}, '{}', ${`h${n}`},
			${recibido}, ${trampa}, 'cowrie', 'contenedor', 'conexion', 'media', true, ${recibido})`;
};

describe('ids de destino', () => {
	it('el del sensor si está libre; si no, con sufijo, recortado para que quepa', () => {
		expect(idDestino('fs01', 1)).toBe('fs01');
		expect(idDestino('fs01', 2)).toBe('fs01-2');
		expect(idDestino('fs01', CANDIDATOS)).toBe(`fs01-${CANDIDATOS}`);
		const largo = 'a'.repeat(63);
		expect(idDestino(largo, 1)).toBe(largo);
		expect(idDestino(largo, 2)).toBe(`${'a'.repeat(61)}-2`);
		expect(idDestino(largo, 100)).toBe(`${'a'.repeat(59)}-100`);
		for (const k of [1, 2, 9, 10, 999, 1000])
			expect(idDestino(largo, k)).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
	});

	it('del nombre que escribe el cliente sale un slug', () => {
		expect(slugDestino('fs01')).toBe('fs01');
		expect(slugDestino('FS01 (Nóminas)')).toBe('fs01-nominas');
		expect(slugDestino('  --Servidor de ficheros, sede Sevilla--  ')).toBe(
			'servidor-de-ficheros-sede-sevilla'
		);
		expect(slugDestino('¿?¡!')).toBe('destino');
		expect(slugDestino('')).toBe('destino');
		const s = slugDestino(`${'x'.repeat(62)} y más`);
		expect(s).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
		expect(s.endsWith('-')).toBe(false);
	});
});

describe('arranque en la imagen', () => {
	it('el Dockerfile copia todo lo que importa arrancar.mjs', () => {
		const dockerfile = readFileSync(join(CONSOLA, 'Dockerfile'), 'utf8');
		const copia = dockerfile.match(/^COPY (apps\/consola\/scripts\/.+) \.\/scripts\/$/m);
		expect(copia).not.toBeNull();
		const copiados = new Set(copia![1].split(/\s+/).map((f) => f.replace('apps/consola/', '')));
		const pendientes = ['scripts/arrancar.mjs'];
		const vistos = new Set<string>();
		while (pendientes.length) {
			const f = pendientes.pop()!;
			if (vistos.has(f)) continue;
			vistos.add(f);
			expect(copiados, `${f} no viaja en la imagen`).toContain(f);
			for (const [, ruta] of readFileSync(join(CONSOLA, f), 'utf8').matchAll(
				/from '(\.{1,2}\/[^']+)'/g
			)) {
				const destino = join(dirname(f), ruta);
				/* El servidor compilado viaja aparte (build/). */
				if (!destino.startsWith('build/')) pendientes.push(destino);
			}
		}
		expect(vistos.size).toBeGreaterThanOrEqual(3);
	});

	it('el arranque completa las trampas con la misma colocación que la migración', () => {
		const sinEspacios = (t: string) => t.replace(/\s+/g, ' ');
		const caso = (t: string) => sinEspacios(t.match(/CASE\s[\s\S]*?\sEND/)![0]);
		const migracion = readFileSync(join(MIGRACIONES, '0012_destinos.sql'), 'utf8');
		const arranque = readFileSync(join(CONSOLA, 'scripts/destinos.mjs'), 'utf8');
		expect(caso(arranque)).toBe(caso(migracion));
	});
});

describe.skipIf(!url)('migración 0012_destinos', () => {
	let base: Awaited<ReturnType<typeof baseTemporal>>;
	let hasta11: string;
	const sql = () => base.sql;

	beforeAll(async () => {
		base = await baseTemporal();
		hasta11 = migracionesHasta('0011_');
		await migrate(drizzle(sql()), { migrationsFolder: hasta11 });

		/* Dos sensores; tres trampas: una con eventos, una «desplegando…» y una con error. */
		await sensorComoAntes(sql(), 'nodo-a', '2026-10-01T08:00:00Z');
		await sensorComoAntes(sql(), 'nodo-b', '2026-10-02T08:00:00Z');
		await insertarComoAntes(sql(), {
			id: 'ssh-backup',
			sensor: 'nodo-a',
			donde: '0.0.0.0:22',
			creado: '2026-10-10T10:00:00Z'
		});
		await insertarComoAntes(sql(), { id: 'smb-nominas', sensor: 'nodo-b' });
		await insertarComoAntes(sql(), {
			id: 'rdp-sala',
			sensor: 'nodo-a',
			donde: 'error: puerto ocupado'
		});
		/* De otra trampa con el mismo id, antes de crearse esta, y del mismo id en otro sensor: no cuentan. */
		await evento(sql(), 'nodo-a', 'ssh-backup', '2026-10-10T09:00:00Z');
		await evento(sql(), 'nodo-b', 'ssh-backup', '2026-10-10T10:30:00Z');
		await evento(sql(), 'nodo-a', 'ssh-backup', '2026-10-10T12:00:00Z');
		await evento(sql(), 'nodo-a', 'ssh-backup', '2026-10-10T11:00:00Z');

		/* Lo demás que puede decir «donde» hoy. */
		const conEventos = async (id: string, donde: string, activo = true) => {
			await insertarComoAntes(sql(), { id, sensor: 'nodo-b', donde, activo });
			await evento(sql(), 'nodo-b', id, new Date(Date.now() + 60_000).toISOString());
		};
		await conEventos('con-error', 'error: el motor no responde');
		await conEventos('parada-sensor', 'parada: cuota superada (registros.sin-perforar): no cabe');
		await conEventos('en-espera', 'en espera: el módulo cowrie no está autorizado');
		await conEventos('pausada', '0.0.0.0:2222', false);
		await conEventos('con-aviso', '0.0.0.0:2223 · aviso: puerto ocupado; sigue como estaba');
		await conEventos('cambiando', 'aplicando cambios…');
		await insertarComoAntes(sql(), { id: 'sin-eventos', sensor: 'nodo-b', donde: '0.0.0.0:23' });

		await migrate(drizzle(sql()), { migrationsFolder: MIGRACIONES });
	});
	afterAll(async () => {
		rmSync(hasta11, { recursive: true, force: true });
		await base?.borrar();
	});

	const trampa = async (id: string) =>
		(await sql()`select * from trampas where id = ${id}`)[0] as Record<string, unknown>;

	it('cada sensor tiene su destino, una máquina con su id', async () => {
		const d = await sql()`select id, nombre, tipo, sensor, descripcion, activo, creado
			from destinos order by id`;
		expect(d.map((x) => ({ ...x, creado: iso(x.creado) }))).toEqual([
			{
				id: 'nodo-a',
				nombre: 'Sensor nodo-a',
				tipo: 'maquina',
				sensor: 'nodo-a',
				descripcion: {},
				activo: true,
				creado: '2026-10-01T08:00:00.000Z'
			},
			{
				id: 'nodo-b',
				nombre: 'Sensor nodo-b',
				tipo: 'maquina',
				sensor: 'nodo-b',
				descripcion: {},
				activo: true,
				creado: '2026-10-02T08:00:00.000Z'
			}
		]);
	});

	it('las trampas quedan en el destino de su sensor, por la vía contenedor', async () => {
		for (const [id, destino] of [
			['ssh-backup', 'nodo-a'],
			['smb-nominas', 'nodo-b'],
			['rdp-sala', 'nodo-a']
		])
			expect(await trampa(id)).toMatchObject({
				destino,
				via: 'contenedor',
				ejecutor: 'contenedor@1',
				manual: null,
				senal_trampa: null,
				colocacion_motivo: null
			});
	});

	it('la de eventos queda comprobada desde su primer evento; las otras dos, por colocar', async () => {
		const t = await trampa('ssh-backup');
		expect(t.colocacion).toBe('comprobada');
		expect(iso(t.comprobada)).toBe('2026-10-10T11:00:00.000Z');
		expect(await trampa('smb-nominas')).toMatchObject({
			colocacion: 'por-colocar',
			comprobada: null
		});
		expect(await trampa('rdp-sala')).toMatchObject({ colocacion: 'por-colocar', comprobada: null });
		const sin = await sql()`select count(*)::int as n from trampas where colocacion_cuando is null`;
		expect(sin[0].n).toBe(0);
	});

	it('el resto de lo que dice «donde» hoy cae en su estado', async () => {
		const colocacion = async (id: string) => (await trampa(id)).colocacion;
		expect(await colocacion('con-error')).toBe('degradada');
		expect(await colocacion('parada-sensor')).toBe('degradada');
		expect(await colocacion('en-espera')).toBe('por-colocar');
		expect(await colocacion('pausada')).toBe('por-colocar');
		expect(await colocacion('con-aviso')).toBe('comprobada');
		expect(await colocacion('cambiando')).toBe('por-colocar');
		expect(await colocacion('sin-eventos')).toBe('colocada');
	});

	it('un estado de colocación que no existe no entra', async () => {
		await expect(
			sql()`update trampas set colocacion = 'activa' where id = 'ssh-backup'`
		).rejects.toThrow(/trampas_colocacion/);
	});

	describe('lo que hace la consola anterior con el esquema nuevo', () => {
		it('su INSERT de trampas, sin las columnas nuevas, entra con los valores por defecto', async () => {
			await insertarComoAntes(sql(), { id: 'de-la-anterior', sensor: 'nodo-a' });
			expect(await trampa('de-la-anterior')).toMatchObject({
				destino: null,
				via: 'contenedor',
				ejecutor: 'contenedor@1',
				colocacion: 'por-colocar',
				comprobada: null
			});
		});

		it('su retirarSensor de un sensor sin eventos deja el destino sin sensor', async () => {
			await sensorComoAntes(sql(), 'nodo-c');
			await sql()`insert into destinos (id, nombre, tipo, sensor) values ('nodo-c', 'nodo-c', 'maquina', 'nodo-c')`;
			/* Lo que hace su retirarSensor tras comprobar que no tiene trampas ni eventos. */
			await sql().begin(async (tx) => {
				await tx`delete from instaladores_sensor where sensor = 'nodo-c'`;
				await tx`delete from sensores where id = 'nodo-c'`;
				await tx`insert into auditoria (quien, accion, detalle) values ('x', 'sensor retirado', '{"id":"nodo-c"}')`;
			});
			expect(await sql()`select id, sensor from destinos where id = 'nodo-c'`).toEqual([
				{ id: 'nodo-c', sensor: null }
			]);
		});

		it('su retirarTrampa de una trampa que es la señal de otra deja a esa sin señal', async () => {
			await insertarComoAntes(sql(), { id: 'cowrie-objetivo', sensor: 'nodo-a' });
			await sql()`insert into trampas (id, nombre, modulo, tipo, sensor, donde, destino, via, ejecutor, senal_trampa)
				values ('credencial-fs01', 'Credencial de fs01', 'credencial-ssh', 'identidad', 'nodo-a', '-',
					'nodo-b', 'windows', 'manual@1', 'cowrie-objetivo')`;
			await sql()`delete from trampas where id = 'cowrie-objetivo'`;
			expect(await trampa('credencial-fs01')).toMatchObject({
				senal_trampa: null,
				destino: 'nodo-b'
			});
		});

		/* Lo de la 0013 (pruebas): tampoco cambia nada de lo que hace la consola anterior. */
		it('su INSERT de eventos, sin «prueba», entra como un evento normal', async () => {
			await insertarComoAntes(sql(), { id: 'ssh-0013', sensor: 'nodo-a' });
			await evento(sql(), 'nodo-a', 'ssh-0013', new Date().toISOString());
			const [e] = await sql()`select prueba from eventos where trampa = 'ssh-0013'`;
			expect(e).toEqual({ prueba: false });
		});

		it('su retirarTrampa de una trampa con pruebas las borra con ella', async () => {
			await sql()`insert into pruebas (trampa, nonce, hasta, quien)
				values ('ssh-0013', 'ab12cd34', now() + interval '15 minutes', 'x')`;
			await sql()`delete from trampas where id = 'ssh-0013'`;
			expect(await sql()`select id from pruebas where trampa = 'ssh-0013'`).toEqual([]);
		});
	});
});

describe.skipIf(!url)('arranque: cada sensor con su destino', () => {
	let base: Awaited<ReturnType<typeof baseTemporal>>;
	const sql = () => base.sql;
	const entorno = { SENSOR_LOCAL_TOKEN: 'token-de-prueba', NODO_ID: 'n1', NODO_NOMBRE: 'Nodo' };

	beforeAll(async () => {
		base = await baseTemporal();
	});
	afterAll(async () => {
		await base?.borrar();
	});

	it('en una base vacía, crea el sensor local y su destino', async () => {
		const r = await prepararBase(sql(), entorno);
		expect(r).toEqual({ destinos: ['local'], trampas: 0 });
		expect(await sql()`select id, nombre, tipo, sensor from destinos`).toEqual([
			{ id: 'local', nombre: 'Sensor local', tipo: 'maquina', sensor: 'local' }
		]);
	});

	it('el sensor local recibe la red que detectó el instalador, solo si aún no tiene', async () => {
		const red = () => sql()`select red, vlan from sensores where id = 'local'`;
		expect(await red()).toEqual([{ red: null, vlan: null }]);
		/* Lo que no se entiende no se guarda. */
		await prepararBase(sql(), { ...entorno, SENSOR_LOCAL_RED: 'eth0', SENSOR_LOCAL_VLAN: '9999' });
		expect(await red()).toEqual([{ red: null, vlan: null }]);
		await prepararBase(sql(), {
			...entorno,
			SENSOR_LOCAL_RED: '10.70.0.9/24',
			SENSOR_LOCAL_VLAN: '70'
		});
		expect(await red()).toEqual([{ red: '10.70.0.0/24', vlan: 70 }]);
		/* Lo que ya tiene (detectado antes o escrito en Sensores) manda. */
		await prepararBase(sql(), { ...entorno, SENSOR_LOCAL_RED: '192.168.1.0/24' });
		expect(await red()).toEqual([{ red: '10.70.0.0/24', vlan: 70 }]);
	});

	it('lo que dio de alta una consola anterior recibe su destino al arrancar', async () => {
		/* Un destino descrito a mano con el id que la consola anterior da después a un sensor. */
		await sql()`insert into destinos (id, nombre, tipo) values ('fs01', 'fs01', 'fileserver')`;
		await sensorComoAntes(sql(), 'remoto1');
		await sensorComoAntes(sql(), 'fs01');
		await insertarComoAntes(sql(), {
			id: 'ssh-remoto',
			sensor: 'remoto1',
			donde: '0.0.0.0:22',
			creado: '2026-10-10T10:00:00Z'
		});
		await insertarComoAntes(sql(), { id: 'ssh-local', sensor: 'local', donde: 'error: fallo' });
		await evento(sql(), 'remoto1', 'ssh-remoto', '2026-10-10T11:00:00Z');

		const r = await prepararBase(sql(), entorno);
		expect(r.destinos.sort()).toEqual(['fs01-2', 'remoto1']);
		expect(r.trampas).toBe(2);
		expect(await sql()`select id, sensor from destinos order by id`).toEqual([
			{ id: 'fs01', sensor: null },
			{ id: 'fs01-2', sensor: 'fs01' },
			{ id: 'local', sensor: 'local' },
			{ id: 'remoto1', sensor: 'remoto1' }
		]);
		const trampas =
			await sql()`select id, destino, colocacion, comprobada from trampas order by id`;
		expect(trampas.map((t) => ({ ...t, comprobada: iso(t.comprobada) }))).toEqual([
			{ id: 'ssh-local', destino: 'local', colocacion: 'por-colocar', comprobada: null },
			{
				id: 'ssh-remoto',
				destino: 'remoto1',
				colocacion: 'comprobada',
				comprobada: '2026-10-10T11:00:00.000Z'
			}
		]);
	});

	it('volver a arrancar no cambia nada', async () => {
		const antes = await sql()`select * from trampas order by id`;
		expect(await prepararBase(sql(), entorno)).toEqual({ destinos: [], trampas: 0 });
		expect(await sql()`select * from trampas order by id`).toEqual(antes);
		const [{ n }] = await sql()`select count(*)::int as n from destinos`;
		expect(n).toBe(4);
	});
});
