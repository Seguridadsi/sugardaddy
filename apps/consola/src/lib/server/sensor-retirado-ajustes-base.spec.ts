/*
 * Un sensor retirado ya no corre ni se conecta: su entorno, su red y si registra su
 * propia máquina se leen, no se cambian. La pantalla no enseña los controles, y aquí
 * se comprueba que el servidor tampoco lo deja hacer por otro camino.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { borrarAuditoriaDePrueba } from './db/pruebas-auditoria';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL)('ajustes de un sensor retirado', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, like } = await import('drizzle-orm');
	const { cambiarEntorno, cambiarRed, cambiarRegistrarPropio } = await import('./gestion');

	const P = 'zz-retiradoajustes';
	const QUIEN = `${P}@prueba`;
	const limpiar = async () => {
		await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
		await borrarAuditoriaDePrueba(db, eq(s.auditoria.quien, QUIEN));
	};
	beforeEach(async () => {
		await limpiar();
		await db.insert(s.sensores).values([
			{ id: `${P}-vivo`, nombre: 'vivo', claveHash: 'a'.repeat(64), remoto: true },
			{
				id: `${P}-retirado`,
				nombre: 'retirado',
				claveHash: 'b'.repeat(64),
				remoto: true,
				entorno: 'perimetro-web',
				retirado: new Date()
			}
		]);
	});
	afterAll(limpiar);

	const leer = async (id: string) =>
		(await db.select().from(s.sensores).where(eq(s.sensores.id, id)))[0];

	it('uno en uso se cambia como siempre', async () => {
		expect(await cambiarEntorno(QUIEN, `${P}-vivo`, 'dentro')).toBe(true);
		expect(await cambiarRegistrarPropio(QUIEN, `${P}-vivo`, true)).toBe(true);
		expect(await cambiarRed(QUIEN, `${P}-vivo`, { red: '10.9.0.0/24', vlan: 9 })).toBe(true);
		expect(await leer(`${P}-vivo`)).toMatchObject({
			entorno: 'dentro',
			registrarPropio: true,
			red: '10.9.0.0/24',
			vlan: 9
		});
	});

	it('uno retirado no cambia nada, ni deja rastro de un cambio', async () => {
		expect(await cambiarEntorno(QUIEN, `${P}-retirado`, 'dentro')).toBe(false);
		expect(await cambiarRegistrarPropio(QUIEN, `${P}-retirado`, true)).toBe(false);
		expect(await cambiarRed(QUIEN, `${P}-retirado`, { red: '10.9.0.0/24', vlan: 9 })).toBe(false);
		expect(await leer(`${P}-retirado`)).toMatchObject({
			entorno: 'perimetro-web',
			registrarPropio: false,
			red: null,
			vlan: null
		});
		expect(await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN))).toEqual([]);
	});
});
