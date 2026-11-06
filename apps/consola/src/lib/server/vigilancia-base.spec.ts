/*
 * Lo que un nodo enseña a quien le vigila, con el latido de verdad y un panel de mentira:
 * apagado no sube nada; encendido, solo lo que toca y sin nada del atacante; lo que no llega
 * se repite; al apagar se borra; y lo que atiende el panel deja de escalarse.
 * DATABASE_URL (del entorno o de .env); si no hay, se salta. Prefijo zz-vig.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	firmarEstado,
	generarClaves,
	type EstadoDeseado,
	type IncidenteSubido
} from '@sugardaddy/canal';

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

const SENSOR = 'zz-vig-sensor';
const TRAMPA = 'zz-vig-trampa';
const CLIENTE = 'zz-vig-cliente';
const NODO = 'zz-vig-nodo';
const panel = generarClaves();
const nodo = generarClaves();

describe.skipIf(!hayBase)('la vigilancia', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, inArray } = await import('drizzle-orm');
	const { cortar, latir, reanudar } = await import('./canal');
	const v = await import('./vigilancia');
	const so = await import('./soporte');
	const t = s.incidentesAbiertos;

	type Envio = { ruta: string; cuerpo: Record<string, unknown> };
	let envios: Envio[] = [];
	let falla: string | null = null;
	let extra: Partial<EstadoDeseado> = {};
	let respuestaIncidentes: Record<string, unknown> = {};

	const estado = (): EstadoDeseado => ({
		version: 1,
		cliente: CLIENTE,
		versionObjetivo: '0.0.1',
		release: null,
		anillo: 'general',
		despliegueEnPausa: false,
		soporte: null,
		modulos: [],
		emitido: new Date().toISOString(),
		caduca: new Date(Date.now() + 600_000).toISOString(),
		...extra
	});

	const panelDeMentira = async (url: string | URL | Request, init?: RequestInit) => {
		const ruta = new URL(String(url)).pathname;
		envios.push({ ruta, cuerpo: JSON.parse(String(init?.body ?? '{}')) });
		if (ruta === falla) return new Response('no', { status: 500 });
		if (ruta === '/api/nodo/latido')
			return new Response(JSON.stringify(firmarEstado(panel.privada, estado())), { status: 200 });
		if (ruta === '/api/nodo/incidentes')
			return new Response(JSON.stringify(respuestaIncidentes), { status: 202 });
		return new Response('{}', { status: 202 });
	};

	const subidas = () => envios.filter((e) => e.ruta === '/api/nodo/incidentes');
	const delLatido = () => envios.find((e) => e.ruta === '/api/nodo/latido')!.cuerpo;
	const incidentes = () => subidas().flatMap((e) => e.cuerpo.incidentes as IncidenteSubido[]);

	const abrir = async (cambios: Partial<typeof t.$inferInsert> = {}) => {
		const ahora = new Date();
		const [f] = await db
			.insert(t)
			.values({
				origen: '203.0.113.7',
				motivo: 'interno',
				severidad: 'alta',
				puntos: 140,
				eventos: 12,
				trampas: [TRAMPA, 'zz-vig-retirada'],
				primero: ahora,
				ultimo: ahora,
				actividad: ahora,
				...cambios
			})
			.returning();
		return f;
	};
	const fila = async (id: string) => (await db.select().from(t).where(eq(t.id, id)))[0];

	const limpiar = async () => {
		await db.delete(t);
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, ['canal', 'vigilancia', 'soporte']));
	};

	beforeAll(async () => {
		await limpiar();
		await db.delete(s.trampas).where(eq(s.trampas.sensor, SENSOR));
		await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		await db.insert(s.trampas).values({
			id: TRAMPA,
			nombre: 'Carpeta de RRHH',
			modulo: 'smb',
			tipo: 'contenedor',
			sensor: SENSOR,
			donde: 'zz',
			clave: 'zz-vig'
		} as typeof s.trampas.$inferInsert);
	});
	beforeEach(async () => {
		await limpiar();
		await db.insert(s.ajustes).values({
			clave: 'canal',
			valor: {
				panel: 'http://localhost:9',
				nodo: NODO,
				cliente: CLIENTE,
				clavePrivada: nodo.privada,
				clavePublica: nodo.publica,
				clavePublicaPanel: panel.publica,
				cortado: false,
				ultimoContacto: null,
				error: null,
				estado: null
			}
		});
		envios = [];
		falla = null;
		extra = {};
		respuestaIncidentes = {};
		vi.stubGlobal('fetch', panelDeMentira);
		process.env.ORIGIN = 'https://zeta.ejemplo.test/';
	});
	afterEach(() => vi.unstubAllGlobals());
	afterAll(async () => {
		await limpiar();
		await db.delete(s.trampas).where(eq(s.trampas.sensor, SENSOR));
		await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
		delete process.env.ORIGIN;
	});

	const errorDelCanal = async () => {
		const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
		return (f.valor as { error: string | null }).error;
	};

	describe('apagada, como viene', () => {
		it('no sube incidentes ni la dirección de la consola', async () => {
			await abrir();
			await latir();
			expect(await errorDelCanal()).toBeNull();
			expect(subidas()).toEqual([]);
			expect(delLatido()).not.toHaveProperty('vigilancia');
		});
	});

	describe('encendida', () => {
		it('sube lo que toca, con nombres y sin nada más', async () => {
			const x = await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			expect(await errorDelCanal()).toBeNull();
			expect(delLatido().vigilancia).toEqual({
				incidentes: true,
				consola: 'https://zeta.ejemplo.test'
			});
			const [i, ...resto] = incidentes();
			expect(resto).toEqual([]);
			expect(i).toMatchObject({ id: x.id, origen: x.origen, severidad: 'alta', eventos: 12 });
			expect(i.trampas).toEqual(['Carpeta de RRHH', 'Removed decoy']);
			expect(Object.keys(i).sort()).toEqual(
				[
					'abierto',
					'atendido',
					'atendidoComo',
					'cerrado',
					'escalados',
					'estado',
					'eventos',
					'id',
					'motivo',
					'origen',
					'primero',
					'puntos',
					'severidad',
					'trampas',
					'ultimo'
				].sort()
			);
		});

		it('lo cerrado de antes de encenderla no sube; lo abierto sí', async () => {
			const antes = new Date(Date.now() - 3600_000);
			const abierto = await abrir({ actividad: antes, ultimo: antes, primero: antes });
			await abrir({
				estado: 'cerrado',
				cerrado: antes,
				actividad: antes,
				origen: '203.0.113.8'
			});
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			expect(incidentes().map((i) => i.id)).toEqual([abierto.id]);
		});

		it('sin cambios no vuelve a mandar nada', async () => {
			await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			expect(subidas()).toHaveLength(1);
			envios = [];
			await latir();
			await latir();
			expect(subidas()).toEqual([]);
		});

		it('lo que cambia se vuelve a subir: eventos, cierre y atención', async () => {
			const x = await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			for (const cambio of [
				{ eventos: 20, actividad: new Date(Date.now() + 1000) },
				{ estado: 'cerrado' as const, cerrado: new Date(Date.now() + 2000) },
				{ atendido: new Date(Date.now() + 3000), atendidoPor: 'Luis', atendidoComo: 'lo-miro' }
			]) {
				envios = [];
				await db.update(t).set(cambio).where(eq(t.id, x.id));
				await latir();
				expect(
					incidentes().map((i) => i.id),
					JSON.stringify(cambio)
				).toEqual([x.id]);
			}
			expect(incidentes()[0].atendidoComo).toBe('lo-miro');
			expect(JSON.stringify(incidentes())).not.toContain('Luis');
			envios = [];
			await latir();
			expect(subidas()).toEqual([]);
		});

		it('si el panel no contesta, se repite y se ve el error', async () => {
			const x = await abrir();
			await v.compartirIncidentes('zz-vig', true);
			falla = '/api/nodo/incidentes';
			await latir();
			expect(await errorDelCanal()).toMatch(/did not accept the incidents/);
			expect((await fila(x.id)).subido).toBeNull();
			falla = null;
			envios = [];
			await latir();
			expect(incidentes().map((i) => i.id)).toEqual([x.id]);
			expect(await errorDelCanal()).toBeNull();
		});

		it('muchos juntos salen por tandas, sin perder ninguno', async () => {
			const ids: string[] = [];
			for (let n = 0; n < v.POR_ENVIO + 5; n++)
				ids.push((await abrir({ origen: `203.0.113.${n + 1}` })).id);
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			expect(incidentes()).toHaveLength(v.POR_ENVIO);
			await latir();
			expect(
				incidentes()
					.map((i) => i.id)
					.sort()
			).toEqual([...ids].sort());
			envios = [];
			await latir();
			expect(subidas()).toEqual([]);
		});

		it('lo grave y abierto sube antes que lo demás, aunque haya cola', async () => {
			await v.compartirIncidentes('zz-vig', true);
			const ahora = new Date();
			for (let n = 0; n < v.POR_ENVIO + 5; n++)
				await abrir({
					origen: `203.0.113.${n + 1}`,
					estado: 'cerrado',
					cerrado: ahora,
					severidad: 'baja'
				});
			const critico = await abrir({ origen: '198.51.100.1', severidad: 'critica' });
			await latir();
			expect(incidentes()[0].id).toBe(critico.id);
		});

		it('un nombre con emoji no deja media letra: el panel no podría guardarlo', async () => {
			const nombre = `${'x'.repeat(59)}😀 de RRHH`;
			await db.update(s.trampas).set({ nombre }).where(eq(s.trampas.id, TRAMPA));
			await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			await db.update(s.trampas).set({ nombre: 'Carpeta de RRHH' }).where(eq(s.trampas.id, TRAMPA));
			const [t0] = incidentes()[0].trampas;
			expect(t0).toBe('x'.repeat(59));
			expect(t0.isWellFormed()).toBe(true);
		});

		it('si el panel descarta alguna, no se repite y queda constancia', async () => {
			const x = await abrir();
			await v.compartirIncidentes('zz-vig', true);
			respuestaIncidentes = { descartadas: 1 };
			await latir();
			expect((await fila(x.id)).subido).not.toBeNull();
			const [a] = await db
				.select()
				.from(s.auditoria)
				.where(eq(s.auditoria.accion, 'Central discarded incidents'));
			expect(a).toBeDefined();
			await db.delete(s.auditoria).where(eq(s.auditoria.accion, 'Central discarded incidents'));
			envios = [];
			await latir();
			expect(subidas()).toEqual([]);
		});

		it('un fallo al subir no deshace el contacto: se ve que hay panel y lo que dijo', async () => {
			await abrir();
			await v.compartirIncidentes('zz-vig', true);
			falla = '/api/nodo/incidentes';
			extra = { operador: 'ACME Seguridad' };
			await latir();
			const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
			const c = f.valor as {
				error: string;
				ultimoContacto: string | null;
				estado: EstadoDeseado | null;
			};
			expect(c.error).toMatch(/did not accept the incidents/);
			expect(c.ultimoContacto).not.toBeNull();
			expect(c.estado?.operador).toBe('ACME Seguridad');
		});

		it('cabe en lo que admite el panel, con nombres largos', async () => {
			const largas = Array.from({ length: 40 }, () => TRAMPA);
			await db
				.update(s.trampas)
				.set({ nombre: 'n'.repeat(200) })
				.where(eq(s.trampas.id, TRAMPA));
			for (let n = 0; n < v.POR_ENVIO; n++)
				await abrir({
					origen: `2001:db8:ffff:ffff:ffff:ffff:ffff:${(n + 1).toString(16)}`,
					trampas: largas,
					atendido: new Date(),
					atendidoComo: 'lo-miro'
				});
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			await db.update(s.trampas).set({ nombre: 'Carpeta de RRHH' }).where(eq(s.trampas.id, TRAMPA));
			const i = incidentes();
			expect(i).toHaveLength(v.POR_ENVIO);
			expect(i[0].trampas).toHaveLength(20);
			expect(i[0].trampas[0]).toHaveLength(60);
			expect(JSON.stringify({ incidentes: i }).length).toBeLessThan(64 * 1024);
		});
	});

	describe('al apagarla', () => {
		it('manda borrar, deja de subir y se reintenta si no llega', async () => {
			await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			await v.compartirIncidentes('zz-vig', false);
			await abrir({ origen: '203.0.113.9' });
			envios = [];
			falla = '/api/nodo/incidentes';
			await latir();
			expect(subidas().map((e) => e.cuerpo)).toEqual([{ borrar: true }]);
			falla = null;
			envios = [];
			await latir();
			expect(subidas().map((e) => e.cuerpo)).toEqual([{ borrar: true }]);
			expect(delLatido()).not.toHaveProperty('vigilancia');
			envios = [];
			await latir();
			expect(subidas()).toEqual([]);
		});

		it('no depende de que vaya bien lo demás', async () => {
			await v.compartirIncidentes('zz-vig', true);
			await v.compartirIncidentes('zz-vig', false);
			extra = { releBalizas: true };
			falla = '/api/nodo/rele';
			await latir();
			expect(await errorDelCanal()).toMatch(/relay beacons/);
			expect(subidas().map((e) => e.cuerpo)).toEqual([{ borrar: true }]);
			expect((await v.vigilancia()).borrar).toBe(false);
		});

		it('al volver a encenderla, se sube otra vez lo abierto', async () => {
			const x = await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			await v.compartirIncidentes('zz-vig', false);
			await latir();
			await v.compartirIncidentes('zz-vig', true);
			envios = [];
			await latir();
			expect(incidentes().map((i) => i.id)).toEqual([x.id]);
		});
	});

	describe('lo que atiende el panel', () => {
		it('queda atendido por esa persona y se confirma al subirlo', async () => {
			const x = await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			extra = { atenciones: [{ id: x.id, por: 'Ana (ACME Seguridad)' }] };
			envios = [];
			await latir();
			expect(await fila(x.id)).toMatchObject({
				atendidoPor: 'Ana (ACME Seguridad)',
				atendidoComo: 'lo-miro'
			});
			/* En ese mismo latido sube ya atendido: es lo que le dice al panel que deje de mandarlo. */
			expect(incidentes()[0]).toMatchObject({ id: x.id, atendidoComo: 'lo-miro' });
			expect(incidentes()[0].atendido).not.toBeNull();
		});

		it('no pisa a quien ya lo atendía, y aguanta un id raro', async () => {
			const x = await abrir({
				atendido: new Date(),
				atendidoPor: 'Luis',
				atendidoComo: 'bloqueada'
			});
			await v.compartirIncidentes('zz-vig', true);
			extra = {
				atenciones: [
					{ id: x.id, por: 'Ana' },
					{ id: 'no-es-uuid', por: 'Ana' },
					{ id: randomUUID(), por: 'Ana' }
				]
			};
			await latir();
			expect(await errorDelCanal()).toBeNull();
			expect(await fila(x.id)).toMatchObject({ atendidoPor: 'Luis', atendidoComo: 'bloqueada' });
		});

		it('si no se comparten, no se aplica', async () => {
			const x = await abrir();
			extra = { atenciones: [{ id: x.id, por: 'Ana' }] };
			await latir();
			expect((await fila(x.id)).atendido).toBeNull();
		});
	});

	describe('al cortar el canal', () => {
		const pedir = () =>
			so.recibirSolicitud({ por: 'Ana', motivo: 'Vigilancia', cuando: new Date().toISOString() });

		it('se cierra el soporte, también el continuo', async () => {
			await pedir();
			await so.aceptar('zz-vig', null, 'operador');
			await cortar('zz-vig');
			expect(await so.abierto()).toBe(false);
		});

		it('se le dice al panel y no se vuelve a hablar con él', async () => {
			await cortar('zz-vig');
			expect(envios.map((e) => e.ruta)).toEqual(['/api/nodo/corte']);
			envios = [];
			await latir();
			expect(envios).toEqual([]);
		});

		it('si el panel no se entera, se reintenta hasta que lo sepa, y nada más', async () => {
			falla = '/api/nodo/corte';
			await cortar('zz-vig');
			expect((await v.vigilancia()).corte).toBe(true);
			envios = [];
			await latir();
			expect(envios.map((e) => e.ruta)).toEqual(['/api/nodo/corte']);
			falla = null;
			envios = [];
			await latir();
			expect(envios.map((e) => e.ruta)).toEqual(['/api/nodo/corte']);
			expect((await v.vigilancia()).corte).toBe(false);
			envios = [];
			await latir();
			expect(envios).toEqual([]);
		});

		it('al reanudarlo, se vuelve a subir lo que toque', async () => {
			const x = await abrir();
			await v.compartirIncidentes('zz-vig', true);
			await latir();
			await cortar('zz-vig');
			envios = [];
			await reanudar('zz-vig');
			expect(incidentes().map((i) => i.id)).toEqual([x.id]);
		});
	});

	describe('el acceso continuo', () => {
		const pedir = () =>
			so.recibirSolicitud({ por: 'Ana', motivo: 'Vigilancia', cuando: new Date().toISOString() });

		it('queda abierto sin plazo hasta que el cliente lo cierra', async () => {
			await pedir();
			expect(await so.aceptar('zz-vig', null, 'lector')).toBe(true);
			expect(await so.soporte()).toMatchObject({ estado: 'abierto', hasta: null, rol: 'lector' });
			expect(await so.abierto()).toBe(true);
			await latir();
			expect(delLatido().soporte).toMatchObject({ estado: 'abierto', hasta: null });
			expect(delLatido().vigilancia).toEqual({
				incidentes: false,
				consola: 'https://zeta.ejemplo.test'
			});
			expect(await so.cerrarYa('zz-vig')).toBe(true);
			expect(await so.abierto()).toBe(false);
		});

		it('con horas sigue caducando', async () => {
			await pedir();
			await so.aceptar('zz-vig', 2, 'lector');
			const { hasta } = await so.soporte();
			expect(Date.parse(hasta!)).toBeGreaterThan(Date.now());
		});
	});

	it('la dirección de la consola solo si es https', async () => {
		await so.recibirSolicitud({ por: 'Ana', motivo: 'x', cuando: new Date().toISOString() });
		await so.aceptar('zz-vig', 2, 'lector');
		process.env.ORIGIN = 'http://zeta.ejemplo.test';
		await latir();
		expect(delLatido().vigilancia).toEqual({ incidentes: false, consola: null });
	});
});
