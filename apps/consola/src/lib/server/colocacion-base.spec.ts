/*
 * La colocación de las trampas contra una base de datos de verdad
 * (docs/diseno/modulo-despliegue.md §8, paso 10): plan(), informarEstado y
 * recibirEventos aplican las transiciones de §8.1 y escriben solo lo que
 * cambia, y lo que ve el cliente (§8.2) se calcula sin escribir nada.
 * DATABASE_URL de .env, como recepcion.spec.ts; si no hay, se salta.
 *
 * El catálogo es uno de prueba (SUGARDADDY_MODULOS) con cowrie y dns-ntp tal
 * cual y el ejemplo v2 de credencial-ssh, que apunta a cowrie.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
/* Lo que autoriza el panel: lo cambia cada prueba. */
const autorizadosAhora = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('./catalogo', async (original) => ({
	...(await original<typeof import('./catalogo')>()),
	autorizados: async () => autorizadosAhora.ids
}));

const { GENESIS, hashEvento, leerCapacidades } = await import('@sugardaddy/contrato');
const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { informarEstado, plan, recibirEventos } = hayBase ? await import('./sensor') : ({} as never);
const { estadosVisibles, cuentaActivas } = hayBase ? await import('./colocacion') : ({} as never);
const { resumen, trampasConEventos } = hayBase ? await import('./consultas') : ({} as never);
const { fichaDestino } = hayBase ? await import('./destinos') : ({} as never);
const { cambiarTrampa } = hayBase ? await import('./gestion') : ({} as never);
const { eq, like, or, sql } = await import('drizzle-orm');

/* Todo lo de esta prueba empieza por zz-co: así se limpia sin tocar nada más. */
const P = 'zz-co';
const S = `${P}-s1`;
const QUIEN = 'zz-prueba-colocacion';
const ANTES = new Date('2026-10-16T09:00:00Z');
const TODOS = ['cowrie', 'dns-ntp', 'credencial-ssh'];

async function limpiar() {
	const mias = like(s.trampas.id, `${P}%`);
	for (const t of [s.eventos, s.cuarentena, s.rupturas])
		await db.delete(t).where(like(t.sensor, `${P}%`));
	await db.update(s.trampas).set({ senalTrampa: null }).where(mias);
	await db.delete(s.trampas).where(mias);
	await db.delete(s.destinos).where(like(s.destinos.id, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
	await db
		.delete(s.auditoria)
		.where(or(eq(s.auditoria.quien, QUIEN), like(s.auditoria.quien, `sensor ${P}%`)));
}

const trampa = async (id: string) =>
	(await db.select().from(s.trampas).where(eq(s.trampas.id, id)))[0];
const estado = async (id: string) => (await estadosVisibles()).get(id)!;

/* xmin cambia con cada escritura de la fila: sirve para contarlas. */
const xmin = async (tabla: 'sensores' | 'trampas' | 'destinos', id: string) =>
	(
		await db.execute<{ x: string }>(
			sql`select xmin::text as x from ${sql.identifier(tabla)} where id = ${id}`
		)
	)[0].x;

/* Una trampa de cowrie en el sensor de la prueba, comprobada desde ayer salvo que se diga otra cosa. */
async function nueva(id: string, x: Partial<typeof s.trampas.$inferInsert> = {}) {
	await db.insert(s.trampas).values({
		id,
		nombre: id,
		modulo: 'cowrie',
		tipo: 'contenedor',
		sensor: S,
		destino: S,
		donde: '0.0.0.0:2222',
		parametros: {},
		colocacion: 'comprobada',
		comprobada: ANTES,
		...x
	});
}

const latir = (cuando = new Date()) =>
	db.update(s.sensores).set({ ultimoLatido: cuando }).where(eq(s.sensores.id, S));

let catalogo = '';
const cowrie = readFileSync('../../modulos/trampas/cowrie/trampa.yaml', 'utf8');
function modulo(id: string, yaml: string) {
	mkdirSync(join(catalogo, 'trampas', id), { recursive: true });
	writeFileSync(join(catalogo, 'trampas', id, 'trampa.yaml'), yaml);
}

beforeAll(async () => {
	if (!hayBase) return;
	catalogo = mkdtempSync(join(tmpdir(), 'sd-colocacion-'));
	modulo('cowrie', cowrie);
	modulo('dns-ntp', readFileSync('../../modulos/trampas/dns-ntp/trampa.yaml', 'utf8'));
	modulo(
		'credencial-ssh',
		readFileSync('../../paquetes/contrato/src/ejemplos/credencial-ssh.v2.yaml', 'utf8')
	);
	process.env.SUGARDADDY_MODULOS = catalogo;
	await limpiar();
	await db
		.insert(s.sensores)
		.values({ id: S, nombre: S, segmento: '-', claveHash: `x-${S}`, ultimoLatido: new Date() });
	await db.insert(s.destinos).values({ id: S, nombre: S, tipo: 'maquina', sensor: S });
});
afterAll(async () => {
	delete process.env.SUGARDADDY_MODULOS;
	if (catalogo) rmSync(catalogo, { recursive: true, force: true });
	if (hayBase && !process.env.CONSERVAR) await limpiar();
});
beforeEach(async () => {
	if (!hayBase) return;
	autorizadosAhora.ids = [...TODOS];
	modulo('cowrie', cowrie);
	await latir();
});

/*
 * Cada causa por la que plan() deja fuera una trampa (§7.3): cómo romperla y
 * cómo arreglarla (la trampa, el catálogo, lo autorizado o el sensor que pide
 * el plan, en «pedido»).
 */
type Caso = {
	codigo: string;
	fila?: Partial<typeof s.trampas.$inferInsert>;
	romper: (id: string) => Promise<unknown> | void;
	arreglar: (id: string) => Promise<unknown> | void;
};
const cambiar = (id: string, v: Partial<typeof s.trampas.$inferInsert>) =>
	db.update(s.trampas).set(v).where(eq(s.trampas.id, id));
let pedido = { registro: true, version: '0.13.1' };
const CASOS: Caso[] = [
	{
		codigo: 'modulo.desconocido',
		romper: (id) => cambiar(id, { modulo: 'no-existe' }),
		arreglar: (id) => cambiar(id, { modulo: 'cowrie' })
	},
	{
		codigo: 'modulo.no-autorizado',
		romper: () => {
			autorizadosAhora.ids = ['dns-ntp'];
		},
		arreglar: () => {
			autorizadosAhora.ids = [...TODOS];
		}
	},
	{
		codigo: 'modulo.via-desaparecida',
		romper: (id) => cambiar(id, { via: 'sensor' }),
		arreglar: (id) => cambiar(id, { via: 'contenedor' })
	},
	{
		codigo: 'agente.version',
		fila: { modulo: 'dns-ntp', parametros: { direccion: '10.20.0.5' }, donde: '0.0.0.0:53' },
		romper: () => {
			pedido = { registro: true, version: '0.12.3' };
		},
		arreglar: () => {
			pedido = { registro: true, version: '0.13.1' };
		}
	},
	{
		codigo: 'carga.imagen-sin-publicar',
		romper: () =>
			modulo('cowrie', cowrie.replace(/@sha256:[0-9a-f]{64}/, `@sha256:${'0'.repeat(64)}`)),
		arreglar: () => modulo('cowrie', cowrie)
	},
	{
		codigo: 'carga.sin-credencial',
		romper: () => {
			pedido = { registro: false, version: '0.13.1' };
		},
		arreglar: () => {
			pedido = { registro: true, version: '0.13.1' };
		}
	},
	{
		codigo: 'parametros.invalidos',
		romper: (id) => cambiar(id, { parametros: { puertoSsh: 'x' } }),
		arreglar: (id) => cambiar(id, { parametros: {} })
	}
];

describe.skipIf(!hayBase)('cada causa de descarte del plan', () => {
	it.each(CASOS.map((c) => [c.codigo, c] as const))(
		'%s: una comprobada pasa a por colocar con su código, deja de contar y vuelve a comprobada',
		async (codigo, c) => {
			const id = `${P}-d-${codigo.replace('.', '-')}`;
			await nueva(id, c.fila);
			pedido = { registro: true, version: '0.13.1' };
			const pedir = () => plan(S, pedido.registro, pedido.version);
			expect((await pedir()).trampas.map((t) => t.id)).toContain(id);
			expect((await estado(id)).activa).toBe(true);

			await c.romper(id);
			const fuera = await pedir();
			expect(fuera.descartados.find((d) => d.id === id)?.codigo).toBe(codigo);
			expect(await trampa(id)).toMatchObject({
				colocacion: 'por-colocar',
				colocacionMotivo: codigo,
				comprobada: ANTES
			});
			const e = await estado(id);
			expect(e).toMatchObject({ estado: 'por-colocar', codigo, activa: false });
			expect(e.motivo).toBe(
				(await trampa(id)).donde.replace(
					/^en espera: (.)(.*)$/,
					(_, a, b) => a.toUpperCase() + b + '.'
				)
			);
			/* El plan se pide cada pocos segundos: lo mismo otra vez no escribe. */
			const x = await xmin('trampas', id);
			await pedir();
			expect(await xmin('trampas', id)).toBe(x);
			/* Un estado que llega tarde (el sensor aún no tenía el plan) no cambia nada. */
			await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }]);
			expect(await xmin('trampas', id)).toBe(x);

			await c.arreglar(id);
			expect((await pedir()).trampas.map((t) => t.id)).toContain(id);
			/* De vuelta en el plan, sigue por colocar hasta que su sensor diga que está. */
			expect(await trampa(id)).toMatchObject({
				colocacion: 'por-colocar',
				donde: 'desplegando…'
			});
			expect((await estado(id)).activa).toBe(false);
			await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }]);
			expect(await trampa(id)).toMatchObject({
				colocacion: 'comprobada',
				colocacionMotivo: null,
				donde: '0.0.0.0:2222'
			});
			expect((await estado(id)).activa).toBe(true);
		}
	);
});

describe.skipIf(!hayBase)('lo que cuenta el sensor de cada trampa', () => {
	it('aislamiento.se-ven en 100 estados seguidos: degradada con una sola escritura', async () => {
		const id = `${P}-se-ven`;
		await nueva(id);
		const informar = () =>
			informarEstado(S, [
				{ id, donde: '0.0.0.0:2222 · aviso: se ven', avisos: ['aislamiento.se-ven'] }
			]);
		await informar();
		expect(await trampa(id)).toMatchObject({
			colocacion: 'degradada',
			colocacionMotivo: 'aislamiento.se-ven'
		});
		const x = await xmin('trampas', id);
		for (let i = 0; i < 99; i++) await informar();
		expect(await xmin('trampas', id)).toBe(x);
		expect(await estado(id)).toMatchObject({ estado: 'degradada', codigo: 'aislamiento.se-ven' });

		/* Un estado con error desde degradada actualiza el motivo, y uno limpio la vuelve a poner. */
		await informarEstado(S, [{ id, donde: 'error: motor.api: no contesta', codigo: 'motor.api' }]);
		expect(await trampa(id)).toMatchObject({
			colocacion: 'degradada',
			colocacionMotivo: 'motor.api'
		});
		expect(await estado(id)).toMatchObject({
			codigo: 'motor.api',
			detalle: 'No contesta.'
		});
		await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }]);
		expect(await trampa(id)).toMatchObject({ colocacion: 'comprobada', colocacionMotivo: null });
	});

	it('una nueva: el primer estado limpio la deja puesta, sin comprobar', async () => {
		const id = `${P}-nueva`;
		await nueva(id, { colocacion: 'por-colocar', comprobada: null, donde: 'desplegando…' });
		await informarEstado(S, [{ id, donde: 'error: descargando la imagen nueva' }]);
		expect(await trampa(id)).toMatchObject({
			colocacion: 'por-colocar',
			colocacionMotivo: 'despliegue.error'
		});
		await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }]);
		expect(await trampa(id)).toMatchObject({ colocacion: 'colocada', colocacionMotivo: null });
		expect(await estado(id)).toMatchObject({ estado: 'colocada', activa: false });
	});

	it('el primer evento fija comprobada una sola vez', async () => {
		const id = `${P}-evento`;
		await nueva(id, { colocacion: 'colocada', comprobada: null });
		let anterior = (await db.select().from(s.sensores).where(eq(s.sensores.id, S)))[0].ultimoHash;
		if (anterior === '0'.repeat(64)) anterior = GENESIS;
		let n = 0;
		const entrega = async () => {
			const lineas: string[] = [];
			for (let i = 0; i < 2; i++) {
				n++;
				const l = JSON.stringify({
					version: 2,
					id: `2b0e0000-0000-4000-8c00-${String(n).padStart(12, '0')}`,
					cuando: new Date(Date.UTC(2026, 9, 17, 10, 0, n)).toISOString(),
					trampa: { id, modulo: 'cowrie', tipo: 'contenedor' },
					sensor: S,
					origen: { ip: '203.0.113.9', usuario: 'root' },
					accion: 'conexion',
					severidad: 'media',
					conexionEstablecida: true,
					hashAnterior: anterior
				});
				lineas.push(l);
				anterior = hashEvento(l);
			}
			return recibirEventos(S, lineas);
		};
		expect(await entrega()).toMatchObject({ aceptadas: 2 });
		const [primero] = await db
			.select({ recibido: s.eventos.recibido })
			.from(s.eventos)
			.where(eq(s.eventos.trampa, id))
			.orderBy(s.eventos.recibido)
			.limit(1);
		const t = await trampa(id);
		expect(t).toMatchObject({ colocacion: 'comprobada', colocacionMotivo: null });
		expect(t.comprobada?.getTime()).toBe(primero.recibido.getTime());
		const x = await xmin('trampas', id);
		expect(await entrega()).toMatchObject({ aceptadas: 2 });
		expect(await xmin('trampas', id)).toBe(x);
		expect((await trampa(id)).comprobada?.getTime()).toBe(primero.recibido.getTime());
	});

	it('parar la deja por colocar; al reanudar, su primer estado limpio la vuelve a poner', async () => {
		const id = `${P}-parar`;
		await nueva(id);
		expect(await cambiarTrampa(QUIEN, id, false)).toBe('hecho');
		expect(await trampa(id)).toMatchObject({ activo: false, colocacion: 'por-colocar' });
		expect(await estado(id)).toMatchObject({ estado: 'parada', activa: false });
		await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }]);
		expect((await trampa(id)).colocacion).toBe('por-colocar');
		expect(await cambiarTrampa(QUIEN, id, true)).toBe('hecho');
		await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }]);
		expect(await trampa(id)).toMatchObject({ activo: true, colocacion: 'comprobada' });
	});
});

describe.skipIf(!hayBase)('lo que ve el cliente, sin escribir nada', () => {
	it('un sensor sin latido se ve sin contacto en todas partes, sin ninguna escritura', async () => {
		const id = `${P}-callado`;
		await nueva(id);
		await latir(new Date(Date.now() - 10 * 60_000));
		const antes = [await xmin('trampas', id), await xmin('sensores', S), await xmin('destinos', S)];
		expect(await estado(id)).toMatchObject({ estado: 'sin-contacto', activa: false });
		expect((await trampasConEventos()).find((t) => t.id === id)?.estado.estado).toBe(
			'sin-contacto'
		);
		const r = await resumen();
		expect(
			r.sensores.find((x) => x.id === S)?.trampas.find((t) => t.id === id)?.estado.estado
		).toBe('sin-contacto');
		expect((await fichaDestino(S))?.trampas.find((t) => t.id === id)?.estado.estado).toBe(
			'sin-contacto'
		);
		expect([
			await xmin('trampas', id),
			await xmin('sensores', S),
			await xmin('destinos', S)
		]).toEqual(antes);
	});

	it('con un fallo del motor, sus trampas se ven degradadas; con la IP del motor, por red.ip-oculta; sin garantía, solo un aviso', async () => {
		const id = `${P}-motor`;
		await nueva(id);
		const motor = { tipo: 'docker', modo: 'rootful', version: '27.3.1', api: '1.47' };
		const con = async (cuerpo: Record<string, unknown>) => {
			await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }], leerCapacidades(cuerpo));
			return estado(id);
		};
		expect(await con({ motor: { codigo: 'motor.inalcanzable', error: 'no llega' } })).toMatchObject(
			{
				estado: 'degradada',
				codigo: 'motor.inalcanzable'
			}
		);
		expect(
			await con({
				motor,
				hechos: { 'red.ipOrigenReal': { valor: false, motivo: 'origen.pasarela' } }
			})
		).toMatchObject({ estado: 'degradada', codigo: 'red.ip-oculta' });
		const sinGarantia = await con({ motor: { ...motor, sinGarantia: true } });
		expect(sinGarantia).toMatchObject({ estado: 'comprobada', activa: true });
		expect(sinGarantia.avisos.map((a) => a.codigo)).toEqual(['motor.sin-garantia']);
		/* Nada de eso se guarda en la trampa: se calcula al leer. */
		expect(await trampa(id)).toMatchObject({ colocacion: 'comprobada', colocacionMotivo: null });
		await informarEstado(S, [{ id, donde: '0.0.0.0:2222' }], leerCapacidades({ motor }));
	});

	describe('una credencial cuya señal es una Cowrie', () => {
		const SSH = `${P}-ssh`;
		const CRED = `${P}-cred`;
		const COW = `${P}-cow`;
		beforeAll(async () => {
			if (!hayBase) return;
			await db.insert(s.destinos).values([
				{
					id: COW,
					nombre: 'cow',
					tipo: 'maquina',
					descripcion: { so: 'linux', direccion: '10.30.0.5' }
				},
				{ id: `${P}-fs01`, nombre: 'fs01', tipo: 'maquina', descripcion: { so: 'windows' } }
			]);
		});
		beforeEach(async () => {
			if (!hayBase) return;
			await db.update(s.trampas).set({ senalTrampa: null }).where(eq(s.trampas.id, CRED));
			await db.delete(s.trampas).where(or(eq(s.trampas.id, CRED), eq(s.trampas.id, SSH)));
			await db
				.update(s.destinos)
				.set({ descripcion: { so: 'linux', direccion: '10.30.0.5' } })
				.where(eq(s.destinos.id, COW));
			await nueva(SSH, { nombre: 'Cowrie de cow', destino: COW, parametros: { puertoSsh: 2222 } });
			await nueva(CRED, {
				nombre: 'Credencial de fs01',
				modulo: 'credencial-ssh',
				tipo: 'identidad',
				destino: `${P}-fs01`,
				via: 'windows',
				ejecutor: 'manual@1',
				donde: '-',
				senalTrampa: SSH,
				parametros: { objetivo: SSH, usuario: 'svc_sql4k7', sesion: 'nas42' },
				/* Lo que guardará el alta de una manual (paso 11): solo lo que mira el estado visible. */
				manual: {
					variables: {
						objetivo_direccion: '10.30.0.5',
						objetivo_puertoSsh: '2222',
						sesion: 'nas42',
						usuario: 'svc_sql4k7'
					},
					marca: { campo: 'origen.usuario', igual: 'svc_sql4k7' }
				} as never
			});
		});

		/* La credencial no se escribe nunca: su estado se calcula. */
		async function sinEscribir<T>(f: () => Promise<T>) {
			const x = await xmin('trampas', CRED);
			const r = await f();
			expect(await xmin('trampas', CRED)).toBe(x);
			return r;
		}

		it('con su objetivo comprobado, comprobada', async () => {
			expect(await sinEscribir(() => estado(CRED))).toMatchObject({
				estado: 'comprobada',
				activa: true
			});
		});

		it('su objetivo sale del plan, se para o su sensor deja de latir: degradada, senal.objetivo-parado', async () => {
			autorizadosAhora.ids = ['dns-ntp', 'credencial-ssh'];
			await plan(S, true, '0.13.1');
			expect(await sinEscribir(() => estado(CRED))).toMatchObject({
				estado: 'degradada',
				codigo: 'senal.objetivo-parado',
				motivo:
					'Cowrie de cow no está recibiendo (pendiente de poner); mientras tanto, esta credencial no avisa de nada.'
			});
			autorizadosAhora.ids = [...TODOS];
			await plan(S, true, '0.13.1');
			await informarEstado(S, [{ id: SSH, donde: '0.0.0.0:2222' }]);
			expect((await estado(CRED)).estado).toBe('comprobada');

			/* La consola no deja pararla (§8.4); una vuelta atrás, sí: se ve igual. */
			expect(await cambiarTrampa(QUIEN, SSH, false)).toEqual({
				dependientes: ['Credencial de fs01']
			});
			await cambiar(SSH, { activo: false, colocacion: 'por-colocar' });
			expect((await sinEscribir(() => estado(CRED))).motivo).toMatch(/\(parada\)/);
			await cambiarTrampa(QUIEN, SSH, true);
			await informarEstado(S, [{ id: SSH, donde: '0.0.0.0:2222' }]);

			await latir(new Date(Date.now() - 10 * 60_000));
			expect(await sinEscribir(() => estado(CRED))).toMatchObject({
				estado: 'degradada',
				codigo: 'senal.objetivo-parado'
			});
			expect((await estado(CRED)).motivo).toMatch(/\(sin contacto\)/);
		});

		it('si cambia el puerto de su objetivo o la dirección de su destino: senal.objetivo-cambiado', async () => {
			await cambiar(SSH, { parametros: { puertoSsh: 2200 } });
			expect(await sinEscribir(() => estado(CRED))).toMatchObject({
				estado: 'degradada',
				codigo: 'senal.objetivo-cambiado',
				motivo:
					'Cowrie de cow ha cambiado (Puerto SSH); lo sembrado apunta a lo de antes. Retírala y vuelve a ponerla.'
			});
			await cambiar(SSH, { parametros: { puertoSsh: 2222 } });
			await db
				.update(s.destinos)
				.set({ descripcion: { so: 'linux', direccion: '10.30.0.6' } })
				.where(eq(s.destinos.id, COW));
			expect((await sinEscribir(() => estado(CRED))).motivo).toMatch(
				/\(la dirección de su destino\)/
			);
		});

		it('sin objetivo (senal_trampa nulo, lo retiró una consola anterior): senal.objetivo-retirado', async () => {
			await cambiar(CRED, { senalTrampa: null });
			await db.delete(s.trampas).where(eq(s.trampas.id, SSH));
			expect(await sinEscribir(() => estado(CRED))).toMatchObject({
				estado: 'degradada',
				codigo: 'senal.objetivo-retirado'
			});
		});
	});

	it('Inicio y el latido al panel cuentan como activas solo las comprobadas que se ven', async () => {
		await latir();
		await db.delete(s.trampas).where(like(s.trampas.id, `${P}-i-%`));
		await nueva(`${P}-i-comprobada`);
		await nueva(`${P}-i-colocada`, { colocacion: 'colocada', comprobada: null });
		await nueva(`${P}-i-degradada`, {
			colocacion: 'degradada',
			colocacionMotivo: 'despliegue.error'
		});
		await nueva(`${P}-i-parada`, { activo: false, colocacion: 'por-colocar' });
		const r = await resumen();
		const mias = r.sensores
			.find((x) => x.id === S)!
			.trampas.filter((t) => t.id.startsWith(`${P}-i-`));
		expect(mias.filter((t) => t.estado.activa).map((t) => t.id)).toEqual([`${P}-i-comprobada`]);
		/* La cifra de Inicio sale de lo mismo que el mapa. */
		const todas = r.sensores.flatMap((x) => x.trampas);
		expect(r.cifras.activos).toBe(todas.filter((t) => t.estado.activa).length);
		const c = await cuentaActivas();
		expect(c.activas).toBeLessThanOrEqual(c.total);
		/* Sin latido, la comprobada tampoco cuenta. */
		await latir(new Date(Date.now() - 10 * 60_000));
		const sin = await resumen();
		expect(sin.sensores.find((x) => x.id === S)!.trampas.filter((t) => t.estado.activa)).toEqual(
			[]
		);
		await latir();
	});
});
