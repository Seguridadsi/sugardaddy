/*
 * La auditoría inmutable contra una base de verdad (migración 0058). DATABASE_URL
 * (del entorno o de .env); si no hay, se salta.
 *
 * Lo que cambia la tabla entera (vaciarla para empezar la cadena de cero, la
 * purga) va dentro de una transacción que se deshace al final: la base
 * compartida de las pruebas queda como estaba.
 */
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import {
	GENESIS,
	firmarSello,
	hashFila,
	verificarAuditoria,
	verificarFilas,
	verificarSello
} from '../../../scripts/auditoria.mjs';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const cadena = hayBase ? await import('./auditoria-cadena') : ({} as never);
const { eq, sql } = await import('drizzle-orm');
const postgres = (await import('postgres')).default;
const pg = hayBase ? postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} }) : null;

afterAll(async () => {
	await pg?.end();
});

const QUIEN = 'zz-auditoria-cadena';
class Deshacer extends Error {}

/*
 * Dentro de una transacción que se deshace: la tabla vacía y la cabeza en el
 * génesis, como en un nodo recién instalado. Vaciarla solo se puede con los
 * triggers apagados (session_replication_role, de superusuario).
 */
async function enLimpio(fn: (tx: TransactionSql) => Promise<void>) {
	await pg!
		.begin(async (tx) => {
			await tx`set local session_replication_role = replica`;
			await tx`delete from auditoria`;
			await tx`delete from auditoria_sellos`;
			await tx`update auditoria_cabeza set ultimo = 0, hash = ${GENESIS} where id = 1`;
			await tx`set local session_replication_role = origin`;
			await fn(tx);
			throw new Deshacer();
		})
		.catch((e) => {
			if (!(e instanceof Deshacer)) throw e;
		});
}

const verificarEn = (tx: TransactionSql) =>
	verificarAuditoria(tx as unknown as Sql, { nodo: 'nodo-prueba' });

describe('la cadena, sin base', () => {
	const fila = (id: number, anterior: string, canonica: string) => ({
		id,
		hashAnterior: anterior,
		hash: hashFila(anterior, canonica),
		canonica,
		accion: 'x',
		detalle: {}
	});

	it('una cadena bien hecha casa; una fila cambiada o quitada, no', () => {
		const a = fila(1, GENESIS, '[1,"a"]');
		const b = fila(2, a.hash, '[2,"b"]');
		const c = fila(3, b.hash, '[3,"c"]');
		expect(verificarFilas([a, b, c]).ok).toBe(true);

		const cambiada = { ...b, canonica: '[2,"B"]' };
		const r = verificarFilas([a, cambiada, c]);
		expect(r.ok).toBe(false);
		expect(r.roturas).toEqual([{ id: 2, motivo: expect.stringContaining('was changed') }]);

		const sinB = verificarFilas([a, c]);
		expect(sinB.roturas).toEqual([{ id: 3, motivo: expect.stringContaining('removed') }]);
	});

	it('un sello firmado se comprueba con la clave del nodo y no con otra', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const privada = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
		const publica = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		const datos = {
			nodo: 'n1',
			hasta: 7,
			hash: 'ab'.repeat(32),
			cuando: '2026-11-14T10:00:00.000Z'
		};
		const ed = firmarSello({ algoritmo: 'ed25519', privada, publica }, datos);
		expect(verificarSello({ ...datos, ...ed }, { publica })).toBe(true);
		expect(verificarSello({ ...datos, ...ed, hash: 'cd'.repeat(32) }, { publica })).toBe(false);
		/* De otro nodo, aunque la firma sea buena: el nodo va en lo firmado. */
		expect(verificarSello({ ...datos, ...ed, nodo: 'n2' }, { publica })).toBe(false);

		const secreto = '11'.repeat(32);
		const hm = firmarSello({ algoritmo: 'hmac-sha256', secreto }, datos);
		expect(verificarSello({ ...datos, ...hm }, { secreto })).toBe(true);
		expect(verificarSello({ ...datos, ...hm }, { secreto: '22'.repeat(32) })).toBe(false);
		expect(verificarSello({ ...datos, ...hm }, {})).toBeNull();
	});
});

describe.skipIf(!hayBase)('la auditoría de la consola solo crece', () => {
	it('un UPDATE sobre la auditoría falla', async () => {
		const [f] = await db
			.insert(s.auditoria)
			.values({ quien: QUIEN, accion: 'zz update' })
			.returning();
		await expect(
			db.update(s.auditoria).set({ quien: 'otro' }).where(eq(s.auditoria.id, f.id))
		).rejects.toThrow();
		const [igual] = await db.select().from(s.auditoria).where(eq(s.auditoria.id, f.id));
		expect(igual.quien).toBe(QUIEN);
	});

	it('un DELETE y un TRUNCATE sobre la auditoría fallan', async () => {
		const [f] = await db
			.insert(s.auditoria)
			.values({ quien: QUIEN, accion: 'zz delete' })
			.returning();
		await expect(db.delete(s.auditoria).where(eq(s.auditoria.id, f.id))).rejects.toThrow();
		await expect(db.execute(sql`truncate auditoria`)).rejects.toThrow();
		expect(await db.select().from(s.auditoria).where(eq(s.auditoria.id, f.id))).toHaveLength(1);
	});

	it('tampoco se cambian ni se borran los sellos', async () => {
		await db.insert(s.auditoria).values({ quien: QUIEN, accion: 'zz para sellar' });
		const sello = (await cadena.sellar())!;
		await expect(
			db.execute(sql`update auditoria_sellos set firma = 'x' where id = ${sello.id}`)
		).rejects.toThrow();
		await expect(
			db.execute(sql`delete from auditoria_sellos where id = ${sello.id}`)
		).rejects.toThrow();
		await expect(db.execute(sql`truncate auditoria_sellos`)).rejects.toThrow();
	});

	it('cada fila nueva cuelga de la anterior, la ponga quien la ponga', async () => {
		const filas = await db
			.insert(s.auditoria)
			.values([
				/* Lo que diga quien inserta en los hash no cuenta: los pone el trigger. */
				{ quien: QUIEN, accion: 'zz uno', hash: 'f'.repeat(64), hashAnterior: 'e'.repeat(64) },
				{ quien: QUIEN, accion: 'zz dos', detalle: { a: 1 } }
			])
			.returning();
		expect(filas[1].hashAnterior).toBe(filas[0].hash);
		expect(filas[0].hash).not.toBe('f'.repeat(64));
		expect((await cadena.verificar(filas[0].id)).roturas).toEqual([]);
	});

	it('la verificación casa con una cadena sana y detecta una fila manipulada o quitada', async () => {
		await enLimpio(async (tx) => {
			for (const n of [1, 2, 3, 4])
				await tx`insert into auditoria (quien, accion, detalle) values (${QUIEN}, ${`zz ${n}`}, ${tx.json({ n })})`;
			const bien = await verificarEn(tx);
			expect(bien.ok).toBe(true);
			expect(bien.filas).toBe(4);
			const ids = (await tx`select id from auditoria order by id`).map(
				(f: Record<string, unknown>) => Number(f.id)
			);

			/* Un superusuario que apaga los triggers y cambia una fila: la verificación lo ve. */
			await tx`set local session_replication_role = replica`;
			await tx`update auditoria set detalle = '{"n": 99}' where id = ${ids[1]}`;
			await tx`set local session_replication_role = origin`;
			const mal = await verificarEn(tx);
			expect(mal.ok).toBe(false);
			expect(mal.roturas).toContainEqual({
				id: ids[1],
				motivo: expect.stringContaining('changed')
			});

			/* Y si además quita otra. */
			await tx`set local session_replication_role = replica`;
			await tx`delete from auditoria where id = ${ids[2]}`;
			await tx`set local session_replication_role = origin`;
			const sinUna = await verificarEn(tx);
			expect(sinUna.roturas).toContainEqual({
				id: ids[3],
				motivo: expect.stringContaining('removed')
			});
		});
	});

	it('quien rehace el hash de la fila cambiada rompe la siguiente', async () => {
		await enLimpio(async (tx) => {
			for (const n of [1, 2, 3])
				await tx`insert into auditoria (quien, accion) values (${QUIEN}, ${`zz ${n}`})`;
			const ids = (await tx`select id from auditoria order by id`).map(
				(f: Record<string, unknown>) => Number(f.id)
			);
			await tx`set local session_replication_role = replica`;
			await tx`update auditoria set accion = 'zz otra',
				hash = auditoria_hash(hash_anterior, auditoria_canonica(id, cuando, quien, 'zz otra', detalle))
				where id = ${ids[1]}`;
			await tx`set local session_replication_role = origin`;
			const r = await verificarEn(tx);
			expect(r.ok).toBe(false);
			expect(r.roturas.map((x) => x.id)).toEqual([ids[2]]);
		});
	});

	it('la purga se lleva el principio, deja su fila y la cadena sigue valiendo', async () => {
		await enLimpio(async (tx) => {
			await tx`insert into auditoria (quien, accion, cuando) values (${QUIEN}, 'zz vieja 1', '2020-01-01')`;
			await tx`insert into auditoria (quien, accion, cuando) values (${QUIEN}, 'zz vieja 2', '2020-02-01')`;
			await tx`insert into auditoria (quien, accion) values (${QUIEN}, 'zz reciente')`;
			/* Con fecha del pasado pero detrás de una reciente: no se va, ni arrastra nada. */
			await tx`insert into auditoria (quien, accion, cuando) values (${QUIEN}, 'zz falsa', '2019-01-01')`;
			const [{ n }] = await tx`select auditoria_purgar('2021-01-01') as n`;
			expect(n).toBe(2);
			const quedan = (await tx`select accion from auditoria order by id`).map(
				(f: Record<string, unknown>) => f.accion
			);
			expect(quedan).toEqual(['zz reciente', 'zz falsa', 'audit log purged']);
			const r = await verificarEn(tx);
			expect(r.roturas).toEqual([]);
			expect(r.ok).toBe(true);
		});
	});

	it('el sello firma la cabeza y la verificación lo comprueba', async () => {
		const [f] = await db
			.insert(s.auditoria)
			.values({ quien: QUIEN, accion: 'zz antes del sello' })
			.returning();
		const sello = await cadena.sellar();
		expect(sello?.hasta).toBe(f.id);
		expect(sello?.hash).toBe(f.hash);
		/* Sin cambios en la cabeza no se vuelve a sellar. */
		expect(await cadena.sellar()).toBeNull();
		const r = await cadena.verificar(f.id);
		expect(r.roturas).toEqual([]);
		expect(r.sellos.mal).toEqual([]);
		expect(r.sellos.bien + r.sellos.sinComprobar).toBeGreaterThanOrEqual(1);
		expect(await cadena.selloParaLatido()).toEqual({
			auditoria: expect.objectContaining({ hasta: f.id, hash: f.hash })
		});
	});
});
