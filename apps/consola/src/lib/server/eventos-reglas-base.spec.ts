/*
 * Perfil de una IP, CRUD de reglas de triaje y aplicación del triaje automático,
 * contra Postgres de verdad (lo que las agregaciones y el onConflictDoNothing no
 * se pueden probar mockeando). Se salta sin DATABASE_URL, como los demás *-base.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Evento } from '@sugardaddy/contrato';

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
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const {
	eventos,
	perfilDeIp,
	perfilDeUsuario,
	reglasTriaje,
	crearReglaTriaje,
	cambiarActivaReglaTriaje,
	borrarReglaTriaje,
	fijarTriaje
} = hayBase ? await import('./consultas') : ({} as never);
const { aplicarTriajeAutoAhora } = hayBase ? await import('./triaje-auto') : ({} as never);
const { eq } = await import('drizzle-orm');

/* Prefijo propio, disjunto del de otros *-base: reglas-base limpia con LIKE
 * 'zz-regla%', que casaría 'zz-reglas' y borraría estos datos a media prueba. */
const SENSOR = 'zz-perfil';
const TRAMPA = 'zz-perfil-t1';
const TRAMPA2 = 'zz-perfil-t2';
const QUIEN = 'zz-perfil-op';
/* Una IP propia de esta prueba: perfilDeIp agrega por IP global y el Postgres es
 * compartido con los demás *-base que corren a la vez, así que no se reutiliza
 * ninguna que use otro spec (p. ej. salidas-canales usa 203.0.113.77). */
const IP = '203.0.113.244';
const IP_OTRA = '198.51.100.244';
/* Un usuario propio (no «root», que lo insertan muchos specs en el Postgres compartido). */
const USUARIO = 'zzperfiluser';
const ID = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fila(n: number, v: Partial<{ ip: string; trampa: string; accion: string; sev: 'baja' | 'media' | 'alta' | 'critica'; input: string }> = {}) {
	const id = ID(n);
	const ip = v.ip ?? IP;
	const trampa = v.trampa ?? TRAMPA;
	const accion = v.accion ?? 'comando';
	const cuando = new Date(Date.UTC(2026, 9, 3, 0, n));
	return {
		id,
		sensor: SENSOR,
		linea: JSON.stringify({
			id,
			cuando: cuando.toISOString(),
			origen: { ip, usuario: USUARIO },
			trampa: { id: trampa, modulo: 'cowrie', tipo: 'contenedor' },
			accion,
			severidad: v.sev ?? 'alta',
			detalle: { input: v.input ?? 'ls -la' }
		}),
		hash: `${SENSOR}-${n}`,
		cuando,
		trampa,
		modulo: 'cowrie',
		tipo: 'contenedor',
		accion,
		severidad: (v.sev ?? 'alta') as 'baja' | 'media' | 'alta' | 'critica',
		ip,
		usuario: USUARIO,
		conexionEstablecida: true
	};
}

/* El evento en su forma parseada (lo que recibe el triaje automático). */
function evento(n: number, v: Parameters<typeof fila>[1] = {}): Evento {
	return JSON.parse(fila(n, v).linea) as Evento;
}

async function limpiar() {
	if (!hayBase) return;
	for (let n = 1; n <= 9; n++) await db.delete(s.triaje).where(eq(s.triaje.evento, ID(n)));
	await db.delete(s.eventos).where(eq(s.eventos.sensor, SENSOR));
	await db.delete(s.trampas).where(eq(s.trampas.sensor, SENSOR));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
	await db.delete(s.reglasTriaje).where(eq(s.reglasTriaje.quien, QUIEN));
	await db.delete(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
}

describe.skipIf(!hayBase)('perfil de IP, reglas y triaje automático', () => {
	beforeAll(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		await db.insert(s.trampas).values([
			{ id: TRAMPA, nombre: 'SSH falso', modulo: 'cowrie', tipo: 'contenedor', sensor: SENSOR, donde: 'ya' },
			{ id: TRAMPA2, nombre: 'Web falsa', modulo: 'cowrie', tipo: 'contenedor', sensor: SENSOR, donde: 'ya' }
		]);
		await db.insert(s.eventos).values([
			fila(1, { sev: 'alta', accion: 'comando' }),
			fila(2, { sev: 'critica', accion: 'comando' }),
			fila(3, { sev: 'media', accion: 'login', trampa: TRAMPA2 }),
			fila(4, { ip: IP_OTRA, sev: 'baja' })
		]);
	});
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('perfilDeIp junta total, trampas, acciones, peor y recientes', async () => {
		const p = await perfilDeIp(IP);
		expect(p).toBeTruthy();
		expect(p!.total).toBe(3);
		expect(p!.peor).toBe('critica');
		expect(p!.trampas.find((t) => t.id === TRAMPA)?.n).toBe(2);
		expect(p!.trampas.find((t) => t.id === TRAMPA2)?.nombre).toBe('Web falsa');
		expect(p!.acciones.find((a) => a.accion === 'comando')?.n).toBe(2);
		expect(p!.recientes.length).toBe(3);
		/* El más reciente primero. */
		expect(p!.recientes[0].id).toBe(ID(3));
		/* Las fechas salen en ISO (con T y Z), como el resto de la consola; new Date no las rompe. */
		expect(p!.primera).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(p!.ultima).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(Number.isNaN(new Date(p!.primera).getTime())).toBe(false);
	});

	it('perfilDeIp de una IP sin eventos es null', async () => {
		expect(await perfilDeIp('192.0.2.231')).toBeNull();
		expect(await perfilDeIp('  ')).toBeNull();
	});

	it('perfilDeUsuario junta sus eventos y las IPs de origen', async () => {
		const p = await perfilDeUsuario(USUARIO);
		expect(p).toBeTruthy();
		/* Los 4 eventos son de este usuario, desde dos IPs. */
		expect(p!.total).toBe(4);
		expect(p!.peor).toBe('critica');
		expect(p!.origenes.map((o) => o.ip).sort()).toEqual([IP, IP_OTRA].sort());
		expect(p!.origenes.find((o) => o.ip === IP)?.n).toBe(3);
		/* Ninguna es IP del motor (los eventos no traen origen.oculta) y no hay más de 20. */
		expect(p!.origenes.every((o) => o.oculta === false)).toBe(true);
		expect(p!.masOrigenes).toBe(false);
		expect(p!.recientes.length).toBe(4);
		/* El más reciente primero (evento 4). */
		expect(p!.recientes[0].id).toBe(ID(4));
		expect(p!.primera).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(await perfilDeUsuario('zzno-existe-user')).toBeNull();
		expect(await perfilDeUsuario('  ')).toBeNull();
	});

	it('eventos() filtra por usuario EXACTO (no búsqueda libre)', async () => {
		const r = await eventos({ usuario: USUARIO });
		expect(r.map((e) => e.id).sort()).toEqual([ID(1), ID(2), ID(3), ID(4)].sort());
		/* Un prefijo del usuario NO casa (es igualdad exacta, no substring). */
		expect((await eventos({ usuario: 'zzperfil' })).some((e) => e.id.startsWith('cccccccc'))).toBe(
			false
		);
	});

	it('CRUD de reglas de triaje con auditoría', async () => {
		const id = await crearReglaTriaje(QUIEN, {
			criterio: 'ip',
			valor: '10.0.0.0/24',
			estado: 'falso-positivo',
			nota: 'rango propio'
		});
		const mias = (await reglasTriaje()).filter((r) => r.quien === QUIEN);
		expect(mias.map((r) => r.id)).toContain(id);
		expect(await cambiarActivaReglaTriaje(QUIEN, id, false)).toBe(true);
		expect((await reglasTriaje()).find((r) => r.id === id)?.activa).toBe(false);
		expect(await borrarReglaTriaje(QUIEN, id)).toBe(true);
		expect(await borrarReglaTriaje(QUIEN, id)).toBe(false);
		/* Quedó rastro en la auditoría (creada, desactivada, borrada). */
		const n = (await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN))).length;
		expect(n).toBeGreaterThanOrEqual(3);
	});

	it('el triaje automático marca los eventos nuevos que casan, sin pisar lo puesto a mano', async () => {
		/* Un triaje a mano en el evento 1: una regla no debe pisarlo. */
		await fijarTriaje(QUIEN, ID(1), 'interesante', 'a mano');
		await crearReglaTriaje(QUIEN, {
			criterio: 'ip',
			valor: IP,
			estado: 'falso-positivo',
			nota: 'escáner'
		});
		await aplicarTriajeAutoAhora([evento(1), evento(2), evento(3)]);

		const triajeDe = async (n: number) =>
			(await db.select().from(s.triaje).where(eq(s.triaje.evento, ID(n))))[0] ?? null;
		/* El 1 conserva el de la persona. */
		expect((await triajeDe(1))?.estado).toBe('interesante');
		expect((await triajeDe(1))?.nota).toBe('a mano');
		/* El 2 y el 3 (IP coincide) quedan marcados por la regla. */
		expect((await triajeDe(2))?.estado).toBe('falso-positivo');
		expect((await triajeDe(2))?.quien).toBe('triaje automático');
		expect((await triajeDe(3))?.estado).toBe('falso-positivo');
	});

	it('sin reglas activas el triaje automático no hace nada', async () => {
		await db.delete(s.triaje).where(eq(s.triaje.evento, ID(4)));
		await db.delete(s.reglasTriaje).where(eq(s.reglasTriaje.quien, QUIEN));
		await aplicarTriajeAutoAhora([evento(4, { ip: IP_OTRA })]);
		const t = (await db.select().from(s.triaje).where(eq(s.triaje.evento, ID(4))))[0];
		expect(t).toBeUndefined();
	});
});
