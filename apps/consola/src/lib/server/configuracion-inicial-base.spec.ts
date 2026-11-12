/*
 * La configuración inicial en la base de verdad: qué se guarda al confirmar y al dejar
 * para más adelante, qué no se deja, cuándo se puede terminar y cuándo se lleva a alguien
 * al asistente. Los hechos que viven en otros módulos se sustituyen: tienen su banco.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const nodo = vi.hoisted(() => ({
	acceso: 'pendiente' as 'pendiente' | 'restringida' | 'abierta',
	codigo: true,
	dominio: null as string | null
}));
vi.mock('./acceso', () => ({ leerAcceso: async () => ({ estado: nodo.acceso, entradas: [] }) }));
vi.mock('./emergencia', () => ({
	estadoCodigoEmergencia: async () =>
		nodo.codigo ? { creado: '2026-01-01T00:00:00Z', por: 'installer' } : null
}));
vi.mock('./identidad', () => ({
	identidad: async () => ({ decidido: !!nodo.dominio, dominio: nodo.dominio })
}));
vi.mock('./registro', () => ({
	puedeRegistrarse: async () => false,
	estadoRegistro: async () => ({ estado: 'sin' })
}));
vi.mock('./consultas', () => ({ autoActualizar: async () => ({ decidido: false }) }));
vi.mock('./edicion', () => ({ esCommunity: () => false }));

describe.skipIf(!process.env.DATABASE_URL)('configuración inicial', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, sql } = await import('drizzle-orm');
	const c = await import('./configuracion-inicial');
	const CLAVE = 'configuracion-inicial';
	const QUIEN = 'zz-configuracion@prueba';
	const USUARIO = { correo: QUIEN, oid: 'local:zz-configuracion' };

	let previo: unknown;
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	previo = f?.valor;

	const limpiar = async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
		await db.delete(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
	};
	beforeEach(async () => {
		await limpiar();
		Object.assign(nodo, { acceso: 'pendiente', codigo: true, dominio: null });
	});
	afterAll(async () => {
		await limpiar();
		if (previo) await db.insert(s.ajustes).values({ clave: CLAVE, valor: previo });
	});

	const estado = async (id: string) =>
		(await c.abrirConfiguracion(USUARIO)).pasos.find((p) => p.id === id)?.estado;

	it('sin nada guardado: sin empezar, y abrirlo lo deja visto', async () => {
		expect(await c.leerConfiguracion()).toEqual({ visto: false, confirmados: {}, terminado: null });
		await c.abrirConfiguracion(USUARIO);
		expect((await c.leerConfiguracion()).visto).toBe(true);
	});

	it('se lleva al asistente una sola vez, y solo a un nodo sin trampas', async () => {
		const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.trampas);
		expect(await c.resumenConfiguracion()).toEqual({ pendiente: true, llevar: n === 0 });
		await c.abrirConfiguracion(USUARIO);
		expect(await c.resumenConfiguracion()).toEqual({ pendiente: true, llevar: false });
	});

	it('confirmar el código lo deja hecho y queda en la auditoría', async () => {
		expect(await estado('codigo')).toBe('pendiente');
		expect(await c.confirmarPaso(QUIEN, 'codigo')).toEqual({ ok: true });
		expect(await estado('codigo')).toBe('hecho');
		const filas = await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
		expect(filas.map((x) => [x.accion, x.detalle])).toEqual([
			['initial setup: step confirmed', { paso: 'codigo' }]
		]);
	});

	it('sin código en el nodo no hay nada que confirmar', async () => {
		nodo.codigo = false;
		expect((await c.confirmarPaso(QUIEN, 'codigo')).ok).toBe(false);
		expect(await estado('codigo')).toBe('pendiente');
	});

	it('solo se confirma a mano lo que no se puede saber, y el código no se omite', async () => {
		expect((await c.confirmarPaso(QUIEN, 'acceso')).ok).toBe(false);
		expect((await c.confirmarPaso(QUIEN, 'trampa')).ok).toBe(false);
		expect((await c.omitirPaso(QUIEN, 'codigo')).ok).toBe(false);
		expect((await c.omitirPaso(QUIEN, 'acceso')).ok).toBe(false);
		expect((await c.omitirPaso(QUIEN, 'no-existe')).ok).toBe(false);
		expect((await c.leerConfiguracion()).confirmados).toEqual({});
	});

	it('no termina con pasos pendientes; con todo hecho u omitido, sí, y desaparece del menú', async () => {
		expect((await c.terminarConfiguracion(USUARIO)).ok).toBe(false);

		await c.confirmarPaso(QUIEN, 'codigo');
		for (const id of ['empresa', 'avisos', 'certificado', 'trampa']) await c.omitirPaso(QUIEN, id);
		/* Falta el acceso, que no se puede omitir: hay que decidirlo en su pantalla. */
		const r = await c.terminarConfiguracion(USUARIO);
		expect(r).toMatchObject({ ok: false });
		expect((await c.leerConfiguracion()).terminado).toBeNull();

		nodo.acceso = 'restringida';
		expect(await c.terminarConfiguracion(USUARIO)).toEqual({ ok: true });
		expect((await c.leerConfiguracion()).terminado).toMatch(/^\d{4}-/);
		expect(await c.resumenConfiguracion()).toEqual({ pendiente: false, llevar: false });
	});

	it('un paso omitido que luego se hace pasa a hecho', async () => {
		await c.omitirPaso(QUIEN, 'empresa');
		expect(await estado('empresa')).toBe('omitido');
		nodo.dominio = 'empresa.es';
		expect(await estado('empresa')).toBe('hecho');
	});
});
