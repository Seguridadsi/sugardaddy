/* La zona horaria de los documentos del nodo: la de serie, la elegida y lo que no vale. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL)('la zona de los documentos del nodo', async () => {
	const { db, schema: s } = await import('./db');
	const { eq } = await import('drizzle-orm');
	const { fijarZonaDocumentos, zonaDocumentos } = await import('./zona-documentos');
	const QUIEN = 'zz-zona@prueba';

	const limpiar = async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'zona-documentos'));
		await db.delete(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
	};
	beforeEach(limpiar);
	afterAll(limpiar);

	it('sin elegir, la de serie', async () => {
		expect(await zonaDocumentos()).toBe('Europe/Madrid');
	});

	it('la elegida se guarda y queda en la auditoría', async () => {
		expect(await fijarZonaDocumentos(QUIEN, 'America/Bogota')).toBe(true);
		expect(await zonaDocumentos()).toBe('America/Bogota');
		const [a] = await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
		expect(a).toMatchObject({
			accion: 'document time zone changed',
			detalle: { zona: 'America/Bogota' }
		});
	});

	it('lo que no es una zona no se guarda, y una guardada que ya no vale no se usa', async () => {
		expect(await fijarZonaDocumentos(QUIEN, '+01:00')).toBe(false);
		expect(await fijarZonaDocumentos(QUIEN, 'Marte/Olympus')).toBe(false);
		await db
			.insert(s.ajustes)
			.values({ clave: 'zona-documentos', valor: { zona: 'Marte/Olympus' } });
		expect(await zonaDocumentos()).toBe('Europe/Madrid');
	});
});
