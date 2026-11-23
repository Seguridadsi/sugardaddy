/*
 * La política de cambios y la aprobación de versiones contra una base de datos de verdad.
 * DATABASE_URL (del entorno o de .env); si no hay, se salta. Deja los ajustes como estaban
 * y borra su auditoría (quien empieza por zz-pol).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { borrarAuditoriaDePrueba } from './db/pruebas-auditoria';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;
/* El suelo del .env de la máquina cambiaría las cuentas: aquí se prueba sin él. */
for (const k of ['ACTUALIZACION_POLITICA', 'ACTUALIZACION_RETARDO_HORAS', 'ACTUALIZACION_VENTANA'])
	delete process.env[k];

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const pol = hayBase ? await import('./politica-actualizacion') : ({} as never);
const { eq, inArray, like } = await import('drizzle-orm');

const P = 'zz-pol';
const CLAVES = ['politica-actualizacion', 'aprobacion-actualizacion'];
const ahora = Date.parse('2026-11-15T12:00:00Z');
const firmada = (version: string, horas: number, urgente = false) => ({
	release: JSON.stringify({
		version,
		publicada: new Date(ahora - horas * 3_600_000).toISOString(),
		...(urgente ? { urgente: true } : {})
	})
});
const pendiente = (version: string, horas: number, urgente = false) => ({
	estado: 'pendiente' as const,
	version,
	release: firmada(version, horas, urgente)
});

describe.skipIf(!hayBase)('política de cambios (base de datos)', () => {
	let antes: { clave: string; valor: unknown }[] = [];
	beforeAll(async () => {
		antes = await db.select().from(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
	});
	afterAll(async () => {
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		if (antes.length) await db.insert(s.ajustes).values(antes);
		await borrarAuditoriaDePrueba(db, like(s.auditoria.quien, `${P}%`));
	});

	it('por defecto, automática: nada espera', async () => {
		expect(await pol.politicaActualizacion()).toEqual({ modo: 'automatica', retardoHoras: 0 });
		expect((await pol.esperaActual(pendiente('9.0.0', 1), ahora)).motivo).toBeNull();
	});

	it('el perfil de banca retiene hasta la aprobación y el retardo, y lo audita', async () => {
		expect(
			await pol.guardarPoliticaActualizacion(`${P}-admin`, { modo: 'manual', retardoHoras: 72 })
		).toBe(true);
		/* Guardar lo mismo no apunta nada. */
		expect(
			await pol.guardarPoliticaActualizacion(`${P}-admin`, { modo: 'manual', retardoHoras: 72 })
		).toBe(false);
		const a = pendiente('9.0.0', 10);
		expect((await pol.esperaActual(a, ahora)).motivo).toBe('aprobacion');
		/* Solo se aprueba la versión que está pendiente. */
		expect(await pol.aprobarActualizacion(`${P}-ana`, '9.0.1', a)).toBe('no-pendiente');
		expect(
			await pol.aprobarActualizacion(`${P}-ana`, '9.0.0', { ...a, estado: 'aplicando' as const })
		).toBe('no-pendiente');
		expect(await pol.aprobarActualizacion(`${P}-ana`, '9.0.0', a)).toBe('aprobada');
		expect(await pol.aprobarActualizacion(`${P}-ana`, '9.0.0', a)).toBe('ya-aprobada');
		expect(await pol.esperaActual(a, ahora)).toEqual({
			motivo: 'retardo',
			hasta: new Date(ahora + 62 * 3_600_000).toISOString()
		});
		expect((await pol.esperaActual(pendiente('9.0.0', 73), ahora)).motivo).toBeNull();
		/* Una versión nueva necesita su propia aprobación, aunque sea urgente. */
		expect((await pol.esperaActual(pendiente('9.1.0', 1, true), ahora)).motivo).toBe('aprobacion');
		await pol.aprobarActualizacion(`${P}-ana`, '9.1.0', pendiente('9.1.0', 1, true));
		expect((await pol.esperaActual(pendiente('9.1.0', 1, true), ahora)).motivo).toBeNull();

		const filas = await db
			.select({ accion: s.auditoria.accion })
			.from(s.auditoria)
			.where(like(s.auditoria.quien, `${P}%`));
		const acciones = filas.map((f) => f.accion);
		expect(acciones.filter((x) => x === 'update policy changed')).toHaveLength(1);
		expect(acciones.filter((x) => x === 'update approved')).toHaveLength(2);
		const [f] = await db
			.select()
			.from(s.ajustes)
			.where(eq(s.ajustes.clave, 'aprobacion-actualizacion'));
		expect((f.valor as { quien: string }).quien).toBe(`${P}-ana`);
	});

	it('guarda la ventana, cuenta el suelo del .env y no lo deja bajar', async () => {
		await pol.guardarPoliticaActualizacion(`${P}-admin`, { modo: 'automatica', retardoHoras: 0 });
		const noche = [{ dias: [1, 2, 3, 4, 5, 6, 7], desde: '02:00', hasta: '04:00' }];
		expect(
			await pol.guardarPoliticaActualizacion(`${P}-admin`, {
				modo: 'automatica',
				retardoHoras: 0,
				ventanas: noche
			})
		).toBe(true);
		expect((await pol.politicaActualizacion()).ventanas).toEqual(noche);
		/* Las 12:00 UTC: fuera de la ventana; abre a las 2 del día siguiente. */
		expect(await pol.esperaActual(pendiente('9.2.0', 1), ahora)).toEqual({
			motivo: 'ventana',
			hasta: '2026-11-16T02:00:00.000Z'
		});
		/* El suelo del .env manda aunque la consola diga automática y sin ventana. */
		await pol.guardarPoliticaActualizacion(`${P}-admin`, { modo: 'automatica', retardoHoras: 0 });
		process.env.ACTUALIZACION_POLITICA = 'manual';
		try {
			expect(pol.sueloActualizacion().modo).toBe('manual');
			expect((await pol.politicaEfectiva()).modo).toBe('manual');
			expect((await pol.esperaActual(pendiente('9.2.0', 1), ahora)).motivo).toBe('aprobacion');
		} finally {
			delete process.env.ACTUALIZACION_POLITICA;
		}
		expect((await pol.esperaActual(pendiente('9.2.0', 1), ahora)).motivo).toBeNull();
	});
});
