/*
 * La lista común con los frenos del nodo, contra una base de verdad (DATABASE_URL del entorno
 * o de .env; si no hay, se salta): el tope diario, la espera y que nada de eso llegue al EDL.
 * La decisión sola, en lista-comun-frenos.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

let hayBase = false;
try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
	hayBase = !!process.env.DATABASE_URL;
} catch {
	hayBase = false;
}
process.env.LISTA_COMUN_TOPE_DIA = '2';
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { aplicarLista, edl, fijarTopeListaComun, listaComunEnEspera, retirarListaGlobal } = hayBase
	? await import('./inteligencia')
	: ({} as never);
const { firmarLista, firmarListaTor, generarClaves } = await import('@sugardaddy/canal');
const { desc, eq } = await import('drizzle-orm');

const panel = generarClaves();
const firmada = (valores: string[]) =>
	firmarLista(panel.privada, {
		version: 1,
		emitida: new Date().toISOString(),
		caduca: new Date(Date.now() + 3600_000).toISOString(),
		indicadores: valores.map((valor) => ({
			valor,
			clase: 'ip' as const,
			motivo: 'Touched a fake service',
			caduca: new Date(Date.now() + 7 * 86_400_000).toISOString()
		}))
	});
const DIA1 = new Date('2026-11-14T10:00:00Z');
const DIA2 = new Date('2026-11-15T10:00:00Z');
const nuevas = ['185.220.101.1', '185.220.101.2', '185.220.101.3', '185.220.101.4'];

describe.skipIf(!hayBase)('la lista común con tope diario', () => {
	const limpiar = async () => {
		await retirarListaGlobal();
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'lista-comun-cupo'));
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'lista-comun-tope'));
	};
	beforeEach(limpiar);
	afterAll(limpiar);

	it('entran dos al día, el resto espera y no llega al EDL; al día siguiente, las siguientes', async () => {
		expect(await aplicarLista(panel.publica, firmada(nuevas), 'prueba', DIA1)).toBe(true);
		const edl1 = await edl();
		expect(edl1).toEqual(expect.arrayContaining(['185.220.101.1', '185.220.101.2']));
		expect(edl1).not.toContain('185.220.101.3');
		expect((await listaComunEnEspera()).entradas.map((e) => e.valor)).toEqual([
			'185.220.101.3',
			'185.220.101.4'
		]);

		/* El mismo día, otra vuelta: el cupo ya está gastado. */
		await aplicarLista(panel.publica, firmada(nuevas), 'prueba', DIA1);
		expect(await edl()).not.toContain('185.220.101.3');

		await aplicarLista(panel.publica, firmada(nuevas), 'prueba', DIA2);
		expect(await edl()).toEqual(expect.arrayContaining(nuevas));
		expect((await listaComunEnEspera()).entradas).toEqual([]);
	});

	it('el tope que pone el administrador en Lists manda sobre el .env, sin desplegar', async () => {
		expect((await listaComunEnEspera()).tope).toBe(2);
		expect(await fijarTopeListaComun('zz-tope', '-1')).toBe('invalido');
		expect(await fijarTopeListaComun('zz-tope', '2.5')).toBe('invalido');
		expect(await fijarTopeListaComun('zz-tope', '10001')).toBe('invalido');
		expect(await fijarTopeListaComun('zz-tope', '3')).toBe('guardado');
		expect(await fijarTopeListaComun('zz-tope', 3)).toBe('igual');
		expect(await listaComunEnEspera()).toMatchObject({ tope: 3, propio: true });

		await aplicarLista(panel.publica, firmada(nuevas), 'prueba', DIA1);
		expect(await edl()).toEqual(expect.arrayContaining(nuevas.slice(0, 3)));
		expect((await listaComunEnEspera()).entradas.map((e) => e.valor)).toEqual(['185.220.101.4']);

		/* La auditoría de la consola solo crece: la última de zz-tope es la de ahora. */
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.quien, 'zz-tope'))
			.orderBy(desc(s.auditoria.id))
			.limit(1);
		expect(a).toMatchObject({
			accion: 'shared list daily limit changed',
			detalle: { antes: 2, tope: 3 }
		});
	});

	it('con 0 no entra nada nuevo', async () => {
		expect(await fijarTopeListaComun('zz-tope', '0')).toBe('guardado');
		await aplicarLista(panel.publica, firmada(nuevas), 'prueba', DIA1);
		expect(await edl()).not.toEqual(expect.arrayContaining(['185.220.101.1']));
		expect((await listaComunEnEspera()).entradas).toHaveLength(4);
	});

	it('lo de una nube o el CGNAT no entra ni espera', async () => {
		await aplicarLista(panel.publica, firmada(['104.16.0.1', '100.64.0.9']), 'prueba', DIA1);
		expect(await edl()).not.toEqual(expect.arrayContaining(['104.16.0.1']));
		expect((await listaComunEnEspera()).entradas).toEqual([]);
	});

	/* Auditoría 2026-11-14: `tipo` dentro de lo firmado, con la transición. */
	it('la lista sin tipo de un panel anterior se aplica y se cuenta; la tipada, sin contar', async () => {
		const alLegado = vi.fn(async () => {});
		expect(await aplicarLista(panel.publica, firmada(nuevas), 'prueba', DIA1, alLegado)).toBe(true);
		expect(alLegado).toHaveBeenCalledTimes(1);
		const tipada = firmarLista(panel.privada, {
			...JSON.parse(firmada(nuevas).lista),
			tipo: 'global'
		});
		expect(await aplicarLista(panel.publica, tipada, 'prueba', DIA1, alLegado)).toBe(true);
		expect(alLegado).toHaveBeenCalledTimes(1);
	});

	it('una lista de Tor firmada por el panel no se aplica como lista global', async () => {
		const tor = firmarListaTor(panel.privada, {
			version: 1,
			tipo: 'tor',
			fuente: 'x',
			emitida: new Date().toISOString(),
			caduca: new Date(Date.now() + 3600_000).toISOString(),
			ips: nuevas
		});
		expect(await aplicarLista(panel.publica, tor, 'prueba', DIA1)).toBe(false);
		expect(await edl()).not.toEqual(expect.arrayContaining(['185.220.101.1']));
	});

	it('firmada por otra clave, no cambia nada', async () => {
		const otra = generarClaves();
		expect(await aplicarLista(otra.publica, firmada(nuevas), 'prueba', DIA1)).toBe(false);
	});
});
