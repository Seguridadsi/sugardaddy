/*
 * Las copias fuera de la máquina contra una base de verdad (DATABASE_URL y
 * CLAVE_SECRETOS; si no, se salta): la credencial se guarda cifrada y solo sale
 * descifrada por la puerta del actualizador; lo que él cuenta se guarda, se
 * audita sin secretos y cierra los pedidos.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL && !!process.env.CLAVE_SECRETOS;

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const c = hayBase ? await import('./copias-fuera') : ({} as never);
const { desc, eq, inArray, like } = await import('drizzle-orm');

const CLAVES = ['copias-destino', 'copias-estado'];
const SECRETO = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYPRUEBAKEY';
const NOMBRE = 'sugardaddy-20261115-031500.tar.age';
const SHA = 'a'.repeat(64);
const LOCAL = { nombre: NOMBRE, bytes: 100, cuando: new Date().toISOString() };

describe.skipIf(!hayBase)('copias fuera de la máquina (base)', () => {
	let previos: (typeof s.ajustes.$inferSelect)[] = [];
	beforeAll(async () => {
		previos = await db.select().from(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
	});
	afterAll(async () => {
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		for (const p of previos) await db.insert(s.ajustes).values(p);
	});

	it('guarda la credencial cifrada y el actualizador la recibe descifrada', async () => {
		const v = c.validar(
			{
				tipo: 's3',
				bucket: 'copias',
				region: 'us-east-1',
				claveId: 'AKIA',
				secreto: SECRETO,
				endpoint: 'https://minio.local:9000'
			},
			null
		);
		expect(v.ok).toBe(true);
		expect(await c.guardarDestino(v as never, 'admin@prueba', 0)).toBe(true);
		const [fila] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'copias-destino'));
		expect(JSON.stringify(fila.valor)).not.toContain(SECRETO);
		const a = await c.paraElActualizador();
		expect(a.activo).toBe(true);
		expect(a.destino).toMatchObject({
			tipo: 's3',
			s3: { claveSecreta: SECRETO, bucket: 'copias', estiloRuta: true }
		});
		expect(a.pruebaToca).toBe(false);
		/* Un formulario viejo no pisa lo guardado. */
		expect(await c.guardarDestino(v as never, 'otro@prueba', 0)).toBe(false);
		const [audit] = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.accion, 'backup destination changed'))
			.orderBy(desc(s.auditoria.id))
			.limit(1);
		expect(JSON.stringify(audit.detalle)).not.toContain(SECRETO);
	});

	it('lo que cuenta el actualizador: subida, error sin secretos, prueba y pedidos', async () => {
		const huella = (await c.paraElActualizador()).huella;
		await c.guardarInforme({
			huella,
			local: LOCAL,
			subidas: [{ nombre: NOMBRE, bytes: 100, sha256: SHA }],
			listadas: true,
			remotas: [
				{ nombre: NOMBRE, bytes: 100 },
				{ nombre: '../malo', bytes: 1 }
			]
		});
		let e = await c.leerEstado();
		expect(e.ultimaSubida).toMatchObject({ nombre: NOMBRE, sha256: SHA });
		expect(e.remotas).toEqual([{ nombre: NOMBRE, bytes: 100 }]);
		const subidas = await db
			.select()
			.from(s.auditoria)
			.where(like(s.auditoria.accion, 'backup uploaded%'))
			.orderBy(desc(s.auditoria.id))
			.limit(1);
		expect(subidas[0].detalle).toMatchObject({ copia: NOMBRE, sha256: SHA });

		/* Ya hay algo subido: toca la primera prueba. */
		expect((await c.paraElActualizador()).pruebaToca).toBe(true);

		await c.guardarInforme({
			huella,
			local: LOCAL,
			error: `uploading: 403 SignatureDoesNotMatch ${SECRETO}`
		});
		e = await c.leerEstado();
		expect(e.ultimoError?.detalle).toContain('SignatureDoesNotMatch');
		expect(e.ultimoError?.detalle).not.toContain(SECRETO);
		expect((await c.problemasCopiasDeAhora()).map((p) => p.codigo)).toContain(
			'salud.copias-sin-subir'
		);

		expect(await c.pedir('prueba', 'admin@prueba')).toBe(true);
		const pedido = (await c.paraElActualizador()).pedidos.prueba;
		expect(pedido).toBeTruthy();
		await c.guardarInforme({
			huella,
			local: LOCAL,
			listadas: true,
			remotas: [{ nombre: NOMBRE, bytes: 100 }],
			hechos: { prueba: pedido },
			prueba: {
				resultado: 'sin-clave',
				detalle: 'Complete and well formed.',
				nombre: NOMBRE,
				huella: 'coincide'
			}
		});
		e = await c.leerEstado();
		expect(e.ultimoError).toBeNull();
		expect(e.prueba).toMatchObject({ resultado: 'sin-clave', pedida: true, huella: 'coincide' });
		expect((await c.paraElActualizador()).pedidos.prueba).toBe('');
		expect((await c.paraElActualizador()).pruebaToca).toBe(false);
		expect(await c.problemasCopiasDeAhora()).toEqual([]);
	});

	it('lo de otro destino no se mezcla', async () => {
		await c.guardarInforme({
			huella: 'otra',
			subidas: [{ nombre: 'sugardaddy-20261116-031500.tar.age', bytes: 1, sha256: SHA }]
		});
		expect((await c.leerEstado()).ultimaSubida?.nombre).toBe(NOMBRE);
	});

	it('quitar el destino deja de dar la credencial', async () => {
		await c.quitarDestino('admin@prueba');
		expect((await c.paraElActualizador()).activo).toBe(false);
	});
});
