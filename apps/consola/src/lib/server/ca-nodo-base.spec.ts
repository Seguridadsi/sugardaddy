/*
 * La CA propia del nodo (docs/diseno/ca-nodo.md), en la base de verdad: lo que
 * cuenta el actualizador, la confirmación del administrador (y cuándo no vale),
 * las raíces que reciben los sensores remotos y lo que queda en la auditoría.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

/* Dos raíces de CA autofirmadas, con openssl: la «de Caddy» y la «propia». */
function raiz(cn: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'ca-nodo-'));
	execFileSync('openssl', [
		'req',
		'-x509',
		'-newkey',
		'ec',
		'-pkeyopt',
		'ec_paramgen_curve:prime256v1',
		'-nodes',
		'-keyout',
		join(dir, 'k.pem'),
		'-out',
		join(dir, 'c.pem'),
		'-subj',
		`/CN=${cn}`,
		'-days',
		'2',
		'-addext',
		'basicConstraints=critical,CA:TRUE'
	]);
	return readFileSync(join(dir, 'c.pem'), 'utf8');
}

let hayOpenssl = true;
try {
	execFileSync('openssl', ['version']);
} catch {
	hayOpenssl = false;
}

describe.skipIf(!process.env.DATABASE_URL || !hayOpenssl)('CA propia del nodo', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, inArray, like } = await import('drizzle-orm');
	const ca = await import('./ca-nodo');
	const QUIEN = 'zz-ca@prueba';
	const PREFIJO = 'zz-ca-';
	const vieja = raiz('Caddy Local Authority - 2026 ECC Root');
	const nueva = raiz('Sugardaddy console root 2026-11-09');
	const huellaNueva = ca.huellaDe(nueva)!;
	const fichero = join(mkdtempSync(join(tmpdir(), 'ca-raiz-')), 'ca-raiz.crt');

	const limpiar = async () => {
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'ca-nodo'));
		await db.delete(s.auditoria).where(inArray(s.auditoria.quien, [QUIEN, 'machine']));
		await db.delete(s.sensores).where(like(s.sensores.id, `${PREFIJO}%`));
		writeFileSync(fichero, vieja);
		process.env.CA_RAIZ = fichero;
		delete process.env.TLS_MODO;
	};
	beforeEach(limpiar);
	afterAll(limpiar);

	const informe = (extra: Record<string, unknown> = {}) =>
		ca.informeDelNodo({
			modo: 'caddy',
			raiz: nueva,
			huella: huellaNueva,
			direccion: 'consola.aldanza.local',
			...extra
		});
	const sensor = (id: string, caConfiada: string | null) =>
		db.insert(s.sensores).values({
			id: PREFIJO + id,
			nombre: `Sede ${id}`,
			claveHash: `${PREFIJO}${id}-hash`,
			remoto: true,
			caConfiada
		});
	const acciones = async () =>
		(
			await db
				.select({ accion: s.auditoria.accion })
				.from(s.auditoria)
				.where(inArray(s.auditoria.quien, [QUIEN, 'machine']))
		).map((a) => a.accion);

	it('guarda la raíz preparada y la anterior, y no acepta lo que no es una CA', async () => {
		expect(await informe()).toBe(true);
		const e = (await ca.leerCaNodo())!;
		expect(e).toMatchObject({
			modo: 'caddy',
			huella: huellaNueva,
			direccion: 'consola.aldanza.local'
		});
		expect(e.anterior).toEqual({
			huella: ca.huellaDe(vieja),
			nombre: 'Caddy Local Authority - 2026 ECC Root'
		});
		expect(await acciones()).toEqual(['node CA root prepared']);
		/* La misma otra vez: no se repite en la auditoría. */
		await informe();
		expect(await acciones()).toHaveLength(1);
		expect(await ca.informeDelNodo({ modo: 'caddy', raiz: 'no es un certificado' })).toBe(false);
		expect(await ca.informeDelNodo({ modo: 'otro' })).toBe(false);
		expect(await ca.informeDelNodo({ modo: 'caddy', raiz: vieja + nueva })).toBe(false);
		expect(await ca.informeDelNodo(null)).toBe(false);
	});

	it('el actualizador solo cambia cuando el administrador confirma esa misma raíz', async () => {
		await informe();
		expect(await ca.paraElActualizador()).toEqual({ cambiar: null });
		expect(await ca.avisoCa(true)).toBe('pendiente');
		expect(await ca.avisoCa(false)).toBe(null);
		const otra = await ca.aprobarCambio(QUIEN, ca.huellaDe(vieja)!);
		expect(otra.ok).toBe(false);
		expect(await ca.paraElActualizador()).toEqual({ cambiar: null });
		/* (true: sin depender de otros sensores remotos que hubiera en la base.) */
		expect((await ca.aprobarCambio(QUIEN, huellaNueva.toLowerCase(), true)).ok).toBe(true);
		expect(await ca.paraElActualizador()).toEqual({ cambiar: huellaNueva });
		expect(await ca.avisoCa(true)).toBe('cambiando');
		expect(await acciones()).toContain('node CA switch confirmed');
		/* El nodo prepara otra (cambió la dirección): la confirmación ya no vale. */
		await ca.informeDelNodo({ modo: 'caddy', raiz: raiz('otra'), direccion: '10.0.0.5' });
		expect(await ca.paraElActualizador()).toEqual({ cambiar: null });
		expect((await ca.leerCaNodo())!.aprobada).toBe(null);
	});

	it('un cambio fallido pide volver a confirmar; uno bueno deja la propia', async () => {
		await informe();
		await ca.aprobarCambio(QUIEN, huellaNueva, true);
		await informe({
			resultado: { estado: 'fallida', detalle: 'https did not come up', huella: huellaNueva }
		});
		let e = (await ca.leerCaNodo())!;
		expect(e.aprobada).toBe(null);
		expect(e.resultado).toMatchObject({ estado: 'fallida', huella: huellaNueva });
		expect(await ca.paraElActualizador()).toEqual({ cambiar: null });
		expect(await ca.avisoCa(true)).toBe('fallida');
		await ca.aprobarCambio(QUIEN, huellaNueva, true);
		writeFileSync(fichero, nueva);
		await ca.informeDelNodo({
			modo: 'propia',
			raiz: nueva,
			direccion: 'consola.aldanza.local',
			resultado: {
				estado: 'aplicada',
				detalle: 'the previous CA was destroyed',
				huella: huellaNueva,
				copias: { limpias: 3, ilegibles: ['sugardaddy-1.tar.enc'] }
			}
		});
		e = (await ca.leerCaNodo())!;
		expect(e).toMatchObject({ modo: 'propia', aprobada: null });
		expect(e.resultado).toMatchObject({
			estado: 'aplicada',
			limpias: 3,
			ilegibles: ['sugardaddy-1.tar.enc']
		});
		/* La anterior se recuerda, para decir cuál quitar de los equipos. */
		expect(e.anterior?.huella).toBe(ca.huellaDe(vieja));
		expect(await ca.avisoCa(true)).toBe(null);
		expect(await acciones()).toEqual(
			expect.arrayContaining(['node CA switch failed', 'node CA switched'])
		);
		/* Ya no se puede confirmar nada. */
		expect((await ca.aprobarCambio(QUIEN, huellaNueva)).ok).toBe(false);
	});

	it('los sensores remotos reciben la vieja y la nueva, y el cambio los espera', async () => {
		expect(await ca.raicesParaSensores()).toBe(vieja.trim() + '\n');
		await informe();
		const ambas = (await ca.raicesParaSensores())!;
		expect(ambas).toContain(vieja.trim());
		expect(ambas).toContain(nueva.trim());
		await sensor('a', null);
		await sensor('b', ca.sha256(ambas));
		const mios = async () =>
			(await ca.sensoresSinRaizNueva()).map((x) => x.id).filter((id) => id.startsWith(PREFIJO));
		expect(await mios()).toEqual([PREFIJO + 'a']);
		const r = await ca.aprobarCambio(QUIEN, huellaNueva);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('Sede a');
		/* Cuando su actualizador las recoge, lo dice. */
		await ca.apuntarRaicesSensor(PREFIJO + 'a', ca.sha256(ambas));
		await ca.apuntarRaicesSensor(PREFIJO + 'a', 'no-es-un-hash');
		expect(await mios()).toEqual([]);
		const otros = (await ca.sensoresSinRaizNueva()).length;
		expect((await ca.aprobarCambio(QUIEN, huellaNueva)).ok).toBe(otros === 0);
	});

	it('se puede confirmar sin los sensores, si se dice', async () => {
		await informe();
		await sensor('apagado', null);
		expect((await ca.aprobarCambio(QUIEN, huellaNueva, true)).ok).toBe(true);
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.accion, 'node CA switch confirmed'));
		expect((a.detalle as { sensoresCortados: string[] }).sensoresCortados).toContain(
			PREFIJO + 'apagado'
		);
	});

	it('con el certificado de la empresa no hay nada que dar ni que confirmar', async () => {
		process.env.TLS_MODO = 'ficheros';
		await ca.informeDelNodo({ modo: 'ficheros' });
		expect(await ca.raicesParaSensores()).toBe(null);
		expect(await ca.avisoCa(true)).toBe(null);
		expect((await ca.aprobarCambio(QUIEN, huellaNueva)).ok).toBe(false);
	});

	it('un nodo con un problema en su CA no deja confirmar', async () => {
		await informe();
		await ca.aprobarCambio(QUIEN, huellaNueva, true);
		await informe({ error: 'an update of the node was left half-done' });
		expect(await ca.paraElActualizador()).toEqual({ cambiar: null });
		expect((await ca.leerCaNodo())!.aprobada).toBe(null);
		expect(await ca.avisoCa(true)).toBe(null);
		expect((await ca.aprobarCambio(QUIEN, huellaNueva)).ok).toBe(false);
	});
});
