/*
 * El alta con destino y elector (docs/diseno/modulo-despliegue.md §7.3, paso
 * 9): el paso «¿dónde?», el formulario de la vía elegida con las otras formas,
 * la comprobación con autoridad al guardar y la de modificar. Por las
 * acciones y el load de las rutas de verdad y contra una base de datos de
 * verdad (DATABASE_URL de .env, como recepcion.spec.ts); si no hay, se salta.
 *
 * El catálogo es uno de prueba (SUGARDADDY_MODULOS) con cowrie y dns-ntp tal
 * cual, y los ejemplos v2 de smb y credencial-ssh. La credencial apunta a una
 * copia de cowrie que solo existe aquí (zz-al-ssh): así las Cowrie que haya en
 * la base de datos de desarrollo no cuentan como su objetivo.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const autorizadosAhora = vi.hoisted(() => ({ ids: ['cowrie', 'dns-ntp', 'smb'] }));
vi.mock('./catalogo', async (original) => {
	const catalogo = await original<typeof import('./catalogo')>();
	return {
		...catalogo,
		autorizados: async () => autorizadosAhora.ids,
		trampasAutorizadas: async () =>
			catalogo.honeycosas().filter((h) => autorizadosAhora.ids.includes(h.id))
	};
});

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { crearDestino } = hayBase ? await import('./destinos') : ({} as never);
const { crearSensor } = hayBase ? await import('./gestion') : ({} as never);
const { informarEstado, plan } = hayBase ? await import('./sensor') : ({} as never);
const rutaAlta = hayBase ? await import('../../routes/trampas/nueva/[modulo]/+page.server') : null;
const rutaAjustes = hayBase ? await import('../../routes/trampas/[id]/+page.server') : null;
const { and, eq, like, or } = await import('drizzle-orm');

const QUIEN = 'zz-prueba-alta';
/* Todo lo de esta prueba empieza por zz-al: así se limpia sin tocar nada más. */
const P = 'zz-al';
const LOCAL = `${P}-local`;
const FS01 = `${P}-fs01`;
const SIN_ROOT = `${P}-sinroot`;
const OCUPADO = `${P}-ocupado`;
const CALLADO = `${P}-callado`;
const WIN = `${P}-win`;
/* El módulo de la trampa SSH a la que apunta la credencial: una copia de cowrie (ver arriba). */
const SSH = `${P}-ssh-modulo`;
const OBJETIVO = `${P}-ssh-objetivo`;

async function limpiar() {
	const mias = like(s.trampas.id, `${P}%`);
	await db.update(s.trampas).set({ senalTrampa: null }).where(mias);
	await db.delete(s.trampas).where(mias);
	await db
		.delete(s.destinos)
		.where(or(like(s.destinos.id, `${P}%`), like(s.destinos.sensor, `${P}%`)));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
	await db
		.delete(s.auditoria)
		.where(or(eq(s.auditoria.quien, QUIEN), like(s.auditoria.quien, `sensor ${P}%`)));
}

/* El cuerpo de §4.4 de un sensor 0.13.1, con lo que se le cambie. */
function estado013(motor: Record<string, unknown> = {}, hechos: Record<string, unknown> = {}) {
	return {
		motor: {
			tipo: 'docker',
			modo: 'rootful',
			version: '27.3.1',
			api: '1.47',
			so: 'linux',
			arquitectura: 'amd64',
			sistema: 'Ubuntu 24.04.1 LTS',
			...motor
		},
		hechos: { 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' }, ...hechos }
	};
}

/* Un sensor 0.13.1 dado de alta como desde Sensores, en línea y con lo que cuente de su máquina. */
async function sensorCon(id: string, capacidades: ReturnType<typeof estado013>) {
	await crearSensor(QUIEN, { id, nombre: `Sensor ${id}`, red: null, vlan: null });
	await db
		.update(s.sensores)
		.set({ ultimoLatido: new Date(), versionAgente: '0.13.1', registroPrivado: true })
		.where(eq(s.sensores.id, id));
	await informarEstado(id, [], capacidades);
}

const locals = (roles = ['admin']) => ({
	usuario: { nombre: 'Prueba', correo: QUIEN, roles },
	modoDesarrollo: false
});

/* La acción de alta de un módulo: lo que devuelve, o el redirect o el error que lanza. */
async function alta(modulo: string, campos: Record<string, string>, roles?: string[]) {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos)) f.append(k, v);
	try {
		return await rutaAlta!.actions.default({
			params: { modulo },
			request: new Request(`http://consola/trampas/nueva/${modulo}`, { method: 'POST', body: f }),
			locals: locals(roles)
		} as never);
	} catch (e) {
		return e;
	}
}

/* La acción de los ajustes de una trampa. */
async function ajustes(id: string, campos: Record<string, string>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos)) f.append(k, v);
	try {
		return await rutaAjustes!.actions.guardar({
			params: { id },
			request: new Request(`http://consola/trampas/${id}`, { method: 'POST', body: f }),
			locals: locals()
		} as never);
	} catch (e) {
		return e;
	}
}

/* El load del alta: sin destino, el paso «¿dónde?»; con él, el formulario. */
async function pagina(modulo: string, consulta: Record<string, string> = {}) {
	const url = new URL(`http://consola/trampas/nueva/${modulo}?${new URLSearchParams(consulta)}`);
	return rutaAlta!.load({ params: { modulo }, url } as never);
}
const enDonde = async (modulo: string, destino: string) =>
	(await pagina(modulo)).donde!.find((d) => d.id === destino);

type Fallo = { status: number; data: { errores: string[]; motivos: { codigo: string }[] } };
const codigos = (r: unknown) => (r as Fallo).data.motivos.map((m) => m.codigo);
const trampa = async (id: string) =>
	(await db.select().from(s.trampas).where(eq(s.trampas.id, id)))[0];

describe.skipIf(!hayBase)('el alta con destino y elector', () => {
	const repo = join(process.cwd(), '../..');
	let carpeta = '';

	beforeAll(async () => {
		carpeta = mkdtempSync(join(tmpdir(), 'sd-alta-'));
		const modulos: Record<string, string> = {
			cowrie: join(repo, 'modulos/trampas/cowrie/trampa.yaml'),
			'dns-ntp': join(repo, 'modulos/trampas/dns-ntp/trampa.yaml'),
			smb: join(repo, 'paquetes/contrato/src/ejemplos/smb.v2.yaml'),
			'credencial-ssh': join(repo, 'paquetes/contrato/src/ejemplos/credencial-ssh.v2.yaml')
		};
		const copia: Record<string, (yaml: string) => string> = {
			[SSH]: (y) => y.replace(/^id: cowrie$/m, `id: ${SSH}`),
			'credencial-ssh': (y) => y.replace('modulos: [cowrie]', `modulos: [${SSH}]`)
		};
		modulos[SSH] = modulos.cowrie;
		for (const [id, fichero] of Object.entries(modulos)) {
			const yaml = readFileSync(fichero, 'utf8');
			mkdirSync(join(carpeta, 'trampas', id), { recursive: true });
			writeFileSync(join(carpeta, 'trampas', id, 'trampa.yaml'), copia[id]?.(yaml) ?? yaml);
		}
		process.env.SUGARDADDY_MODULOS = carpeta;

		await limpiar();
		await sensorCon(LOCAL, estado013());
		await sensorCon(
			SIN_ROOT,
			estado013(
				{ modo: 'rootless' },
				{ 'red.ipOrigenReal': { valor: false, motivo: 'origen.rootless' } }
			)
		);
		await sensorCon(
			OCUPADO,
			estado013({}, { 'puertos.ocupados': { valor: ['udp/53', 'tcp/8080'] } })
		);
		await sensorCon(CALLADO, estado013());
		await db
			.update(s.sensores)
			.set({ ultimoLatido: new Date(Date.now() - 3_600_000) })
			.where(eq(s.sensores.id, CALLADO));
		await crearDestino(QUIEN, {
			nombre: FS01,
			tipo: 'fileserver',
			descripcion: { so: 'windows', version: '10.0.17763', powershell: '5.1' }
		});
		await crearDestino(QUIEN, {
			nombre: WIN,
			tipo: 'maquina',
			descripcion: { so: 'windows', edicion: 'puesto', powershell: '5.1' }
		});
	});
	afterAll(async () => {
		delete process.env.SUGARDADDY_MODULOS;
		if (carpeta) rmSync(carpeta, { recursive: true, force: true });
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('el paso «¿dónde?» da cada destino con lo que diría el elector, primero los que valen', async () => {
		const p = await pagina('cowrie');
		expect(p.forma).toBeNull();
		expect(p.modulo).toMatchObject({ id: 'cowrie' });
		const mios = p.donde!.filter((d) => d.id.startsWith(P));
		expect(mios.find((d) => d.id === LOCAL)).toMatchObject({
			tipo: 'maquina',
			plataforma: 'Ubuntu 24.04.1 LTS',
			sensor: { nombre: `Sensor ${LOCAL}`, vivo: true },
			elegida: { via: 'contenedor', nombre: 'En un sensor', avisos: [] },
			motivo: null,
			bloqueo: null
		});
		expect(mios.find((d) => d.id === FS01)).toMatchObject({
			elegida: null,
			motivo: { codigo: 'agente.falta' }
		});
		expect(mios.find((d) => d.id === SIN_ROOT)).toMatchObject({
			elegida: null,
			motivo: { codigo: 'requisito.no-cumple' }
		});
		/* Vale, pero ahora no: el alta exige su sensor en línea. Sin el aviso del elector, que diría otra cosa. */
		expect(mios.find((d) => d.id === CALLADO)).toMatchObject({
			elegida: { via: 'contenedor', avisos: [] },
			bloqueo: expect.stringMatching(/no contesta ahora/)
		});
		/* Primero los que valen, después los que ahora no se puede y al final los que no valen. */
		const orden = mios.map((d) => d.id);
		expect(orden.indexOf(LOCAL)).toBeLessThan(orden.indexOf(CALLADO));
		expect(orden.indexOf(CALLADO)).toBeLessThan(orden.indexOf(FS01));
		expect(orden.indexOf(CALLADO)).toBeLessThan(orden.indexOf(SIN_ROOT));
	});

	it('cowrie en local crea la fila con la vía contenedor y entra en el plan', async () => {
		const f = (await pagina('cowrie', { destino: LOCAL })).forma!;
		expect(f).toMatchObject({
			destino: { id: LOCAL, nombre: `Sensor ${LOCAL}` },
			eleccion: { elegida: { via: 'contenedor', ejecutor: 'contenedor@1' } },
			bloqueo: null
		});
		/* Lo que se va a ejecutar: el manifiesto v1 de la vía, sin la imagen pública. */
		expect(f.manifiesto?.contenedor?.imagen).toMatch(/sugardaddy-trampa-cowrie/);
		expect(f.manifiesto?.contenedor).not.toHaveProperty('imagenPublica');

		const r = await alta('cowrie', {
			id: `${P}-ssh`,
			nombre: 'srv-backup01',
			destino: LOCAL,
			via: 'contenedor',
			'p.puertoSsh': '2201'
		});
		expect(r).toMatchObject({ status: 303, location: '/trampas?creado=srv-backup01' });
		expect(await trampa(`${P}-ssh`)).toMatchObject({
			modulo: 'cowrie',
			tipo: 'contenedor',
			destino: LOCAL,
			via: 'contenedor',
			ejecutor: 'contenedor@1',
			sensor: LOCAL,
			donde: 'desplegando…',
			parametros: { puertoSsh: 2201 }
		});
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, 'trampa creada')));
		expect(a.detalle).toMatchObject({ id: `${P}-ssh`, destino: LOCAL, via: 'contenedor' });
		const x = await plan(LOCAL, true, '0.13.1');
		expect(x.trampas.map((t) => t.id)).toEqual([`${P}-ssh`]);
		expect(x.descartados).toEqual([]);
	});

	it('cowrie en fs01 enseña agente.falta y no deja guardar', async () => {
		const f = (await pagina('cowrie', { destino: FS01 })).forma!;
		expect(f.eleccion).toMatchObject({
			elegida: null,
			motivo: { codigo: 'agente.falta' },
			vias: [{ via: 'contenedor', vale: false, motivos: [{ codigo: 'agente.falta' }] }]
		});
		/* Un servidor de ficheros Windows: el remedio es la appliance. */
		expect(f.eleccion.motivo?.remedio).toMatch(/appliance/);
		expect(f.manifiesto).toBeNull();

		const r = await alta('cowrie', {
			id: `${P}-ssh-fs01`,
			nombre: 'fs01',
			destino: FS01,
			via: 'contenedor',
			'p.puertoSsh': '2222'
		});
		expect(r).toMatchObject({ status: 400 });
		expect(codigos(r)).toEqual(['agente.falta']);
		expect(await trampa(`${P}-ssh-fs01`)).toBeUndefined();
	});

	it('en un sensor rootless no deja guardar, con requisito.no-cumple (motor.modo) y su remedio', async () => {
		const r = await alta('cowrie', {
			id: `${P}-ssh-sinroot`,
			nombre: 'sinroot',
			destino: SIN_ROOT,
			via: 'contenedor',
			'p.puertoSsh': '2222'
		});
		expect(r).toMatchObject({ status: 400 });
		const [m] = (r as { data: { motivos: { codigo: string; texto: string; remedio?: string }[] } })
			.data.motivos;
		expect(m).toMatchObject({ codigo: 'requisito.no-cumple' });
		expect(m.texto).toMatch(/\(Cómo corre el motor: sin root\)/);
		expect(m.remedio).toMatch(/Docker con root/);
		expect(await trampa(`${P}-ssh-sinroot`)).toBeUndefined();
	});

	it('con el sensor sin contacto no se pone, como siempre', async () => {
		const f = (await pagina('cowrie', { destino: CALLADO })).forma!;
		expect(f.bloqueo).toMatch(/no contesta ahora/);
		const r = await alta('cowrie', {
			id: `${P}-ssh-callado`,
			nombre: 'callado',
			destino: CALLADO,
			'p.puertoSsh': '2222'
		});
		expect(r).toMatchObject({ status: 400 });
		expect((r as Fallo).data.errores).toEqual([expect.stringMatching(/no contesta ahora/)]);
		expect(await trampa(`${P}-ssh-callado`)).toBeUndefined();
	});

	it('dns-ntp con el 53 en un destino con udp/53 ocupado falla con puertos.ocupado', async () => {
		/* En el paso «¿dónde?» vale, con el aviso: con otro puerto valdría. */
		expect(await enDonde('dns-ntp', OCUPADO)).toMatchObject({
			elegida: { via: 'contenedor', avisos: [{ codigo: 'puertos.ocupado' }] }
		});
		const campos = {
			id: `${P}-dns`,
			nombre: 'ns2',
			destino: OCUPADO,
			via: 'contenedor',
			'p.puertoDns': '53'
		};
		const r = await alta('dns-ntp', campos);
		expect(r).toMatchObject({ status: 400 });
		expect(codigos(r)).toEqual(['puertos.ocupado']);
		expect((r as { data: { motivos: { texto: string }[] } }).data.motivos[0].texto).toBe(
			`Sensor ${OCUPADO} ya usa el puerto UDP 53; elige otro o libéralo allí.`
		);
		/* Lo escrito vuelve al formulario. */
		expect((r as { data: unknown }).data).toMatchObject({
			id: `${P}-dns`,
			valores: { puertoDns: '53' }
		});
		expect(await trampa(`${P}-dns`)).toBeUndefined();
		/* Con otro puerto, sí. */
		expect(await alta('dns-ntp', { ...campos, 'p.puertoDns': '5353' })).toMatchObject({
			status: 303
		});
	});

	it('el choque con otra trampa del destino sigue saliendo, ahora como puertos.otra-trampa', async () => {
		const r = await alta('cowrie', {
			id: `${P}-ssh-2`,
			nombre: 'srv-backup02',
			destino: LOCAL,
			'p.puertoSsh': '2201'
		});
		expect(r).toMatchObject({ status: 400 });
		expect((r as { data: { motivos: unknown[] } }).data.motivos).toEqual([
			{
				codigo: 'puertos.otra-trampa',
				texto: 'El puerto 2201 ya lo usa la trampa srv-backup01 en este destino.'
			}
		]);
		/* Una que una consola anterior dejó sin destino cuenta en el de su sensor. */
		await db.insert(s.trampas).values({
			id: `${P}-ssh-sin-destino`,
			nombre: 'de antes',
			modulo: 'cowrie',
			tipo: 'contenedor',
			sensor: LOCAL,
			parametros: { puertoSsh: 2250 },
			donde: '0.0.0.0:2250'
		});
		const x = await alta('cowrie', {
			id: `${P}-ssh-3`,
			nombre: 'srv-backup03',
			destino: LOCAL,
			'p.puertoSsh': '2250'
		});
		expect((x as { data: { motivos: unknown[] } }).data.motivos).toEqual([
			{
				codigo: 'puertos.otra-trampa',
				texto: 'El puerto 2250 ya lo usa la trampa de antes en este destino.'
			}
		]);
		await db.delete(s.trampas).where(eq(s.trampas.id, `${P}-ssh-sin-destino`));
	});

	it('dos altas a la vez con el mismo puerto en el mismo destino: solo se guarda una', async () => {
		const de = (id: string) =>
			alta('cowrie', { id, nombre: id, destino: LOCAL, 'p.puertoSsh': '2240' });
		const r = await Promise.all([de(`${P}-a-la-vez-1`), de(`${P}-a-la-vez-2`)]);
		expect(r.map((x) => (x as { status: number }).status).sort()).toEqual([303, 400]);
		expect(codigos(r.find((x) => (x as { status: number }).status === 400))).toEqual([
			'puertos.otra-trampa'
		]);
	});

	it('una vía no válida mandada a mano por POST da 400 con sus motivos', async () => {
		/* La carpeta auditada de smb es para servidores de ficheros: en una máquina no vale. */
		const r = await alta('smb', {
			id: `${P}-smb`,
			nombre: 'fs02',
			destino: LOCAL,
			via: 'carpeta-auditada'
		});
		expect(r).toMatchObject({ status: 400 });
		expect(codigos(r)).toEqual(['destino.tipo']);
		/* Una forma que el módulo no tiene. */
		const x = await alta('smb', {
			id: `${P}-smb`,
			nombre: 'fs02',
			destino: LOCAL,
			via: 'no-existe'
		});
		expect(x).toMatchObject({
			status: 400,
			data: { errores: ['Esa forma de ponerla no existe en este módulo.'] }
		});
		/* Un destino que no existe. */
		const d = await alta('smb', { id: `${P}-smb`, nombre: 'fs02', destino: `${P}-no` });
		expect(d).toMatchObject({
			status: 400,
			data: { errores: ['Destino: ese destino ya no existe; elige otro.'] }
		});
		expect(await trampa(`${P}-smb`)).toBeUndefined();
		/* En el formulario, la otra forma sale con su motivo. */
		const f = (await pagina('smb', { destino: LOCAL, via: 'carpeta-auditada' })).forma!;
		expect(f.eleccion.elegida?.via).toBe('contenedor');
		expect(f.eleccion.vias.find((v) => v.via === 'carpeta-auditada')).toMatchObject({
			vale: false,
			motivos: [{ codigo: 'destino.tipo' }]
		});
	});

	it('quien no despliega no puede poner trampas', async () => {
		const r = await alta(
			'cowrie',
			{ id: `${P}-x`, nombre: 'x', destino: LOCAL, 'p.puertoSsh': '2299' },
			['lector']
		);
		expect(r).toMatchObject({ status: 403 });
	});

	describe('credencial-ssh, que solo se pone a mano', () => {
		beforeAll(async () => {
			autorizadosAhora.ids = ['cowrie', 'credencial-ssh'];
			/* Una trampa SSH en local, ya comprobada; su destino aún sin dirección. */
			await db.insert(s.trampas).values({
				id: OBJETIVO,
				nombre: 'Cowrie de local',
				modulo: SSH,
				tipo: 'contenedor',
				sensor: LOCAL,
				destino: LOCAL,
				parametros: { puertoSsh: 2231 },
				donde: '0.0.0.0:2231',
				colocacion: 'comprobada',
				comprobada: new Date()
			});
		});
		afterAll(() => {
			autorizadosAhora.ids = ['cowrie', 'dns-ntp', 'smb'];
		});

		it('en «¿dónde?» sale «vale por Pasos para Windows» en un destino Windows si hay una Cowrie con dirección, sin rellenar nada', async () => {
			expect(await enDonde('credencial-ssh', WIN)).toMatchObject({
				elegida: null,
				motivo: { codigo: 'senal.objetivo-sin-direccion' }
			});
			await db
				.update(s.destinos)
				.set({ descripcion: { direccion: '10.30.0.5' } })
				.where(eq(s.destinos.id, LOCAL));
			expect(await enDonde('credencial-ssh', WIN)).toMatchObject({
				elegida: { via: 'windows', nombre: 'Pasos para Windows' },
				motivo: null,
				bloqueo: null
			});
			/* En una máquina Linux, la de Linux. */
			expect((await enDonde('credencial-ssh', LOCAL))?.elegida).toMatchObject({
				via: 'linux',
				nombre: 'Pasos para Linux'
			});
		});

		it('sin ninguna Cowrie colocada, senal.trampa-objetivo', async () => {
			await db
				.update(s.trampas)
				.set({ colocacion: 'por-colocar' })
				.where(eq(s.trampas.id, OBJETIVO));
			try {
				expect(await enDonde('credencial-ssh', WIN)).toMatchObject({
					elegida: null,
					motivo: { codigo: 'senal.trampa-objetivo' }
				});
			} finally {
				await db
					.update(s.trampas)
					.set({ colocacion: 'comprobada' })
					.where(eq(s.trampas.id, OBJETIVO));
			}
		});

		it('el formulario dice lo que harás y a qué trampa puede apuntar; al guardar, va a sus pasos', async () => {
			const f = (await pagina('credencial-ssh', { destino: WIN })).forma!;
			expect(f.eleccion.elegida).toMatchObject({ via: 'windows', ejecutor: 'manual@1' });
			expect(f.bloqueo).toBeNull();
			expect(f.manifiesto).toBeNull();
			expect(f.pasos).toMatchObject({
				lenguaje: 'powershell',
				pasos: [
					'Guarda en el perfil del usuario una sesión de PuTTY «Nombre de la conexión» hacia la dirección de «Trampa SSH a la que apunta».'
				],
				retirada: ['Borra la sesión «Nombre de la conexión» de PuTTY.']
			});
			expect(f.objetivos.objetivo).toEqual([
				{ id: OBJETIVO, nombre: 'Cowrie de local', destino: `Sensor ${LOCAL}`, motivo: null }
			]);
			const r = await alta('credencial-ssh', {
				id: `${P}-cred`,
				nombre: 'Credencial de win',
				destino: WIN,
				via: 'windows',
				'p.objetivo': OBJETIVO,
				'p.usuario': 'svc_sql4k7',
				'p.sesion': 'nas42'
			});
			expect(r).toMatchObject({ status: 303, location: `/trampas/${P}-cred` });
			expect(await trampa(`${P}-cred`)).toMatchObject({
				ejecutor: 'manual@1',
				via: 'windows',
				destino: WIN,
				sensor: LOCAL,
				senalTrampa: OBJETIVO,
				colocacion: 'por-colocar'
			});
		});
	});

	describe('modificar vuelve a pasar el elector', () => {
		it('un puerto que ya usa otra trampa del destino no se guarda; el suyo propio, sí', async () => {
			/* La de dns-ntp en OCUPADO usa el 5353; una Cowrie en el mismo destino. */
			expect(
				await alta('cowrie', {
					id: `${P}-ssh-oc`,
					nombre: 'srv-oc',
					destino: OCUPADO,
					'p.puertoSsh': '2201'
				})
			).toMatchObject({ status: 303 });
			const r = await ajustes(`${P}-ssh-oc`, { nombre: 'srv-oc', 'p.puertoSsh': '5353' });
			expect(r).toMatchObject({ status: 400 });
			expect(codigos(r)).toEqual(['puertos.otra-trampa']);
			expect(await trampa(`${P}-ssh-oc`)).toMatchObject({ parametros: { puertoSsh: 2201 } });
			/* Otro que el destino ya usa (tcp/8080), tampoco. */
			expect(codigos(await ajustes(`${P}-ssh-oc`, { nombre: 'x', 'p.puertoSsh': '8080' }))).toEqual(
				['puertos.ocupado']
			);
			/* Su propio puerto no choca consigo misma, y el nombre se cambia. */
			expect(
				await ajustes(`${P}-ssh-oc`, { nombre: 'srv-oc2', 'p.puertoSsh': '2201' })
			).toMatchObject({
				status: 303
			});
			expect(await trampa(`${P}-ssh-oc`)).toMatchObject({
				nombre: 'srv-oc2',
				donde: 'aplicando cambios…'
			});
		});

		it('lo que es de la máquina sale como aviso y no impide guardar', async () => {
			/* Una trampa que ya estaba en el sensor rootless (de antes de exigir root). */
			await db.insert(s.trampas).values({
				id: `${P}-ssh-viejo`,
				nombre: 'viejo',
				modulo: 'cowrie',
				tipo: 'contenedor',
				sensor: SIN_ROOT,
				destino: SIN_ROOT,
				parametros: { puertoSsh: 2222 },
				donde: '0.0.0.0:2222'
			});
			const p = await rutaAjustes!.load({ params: { id: `${P}-ssh-viejo` } } as never);
			if (p.tipo !== 'contenedor') throw new Error('es de contenedor');
			expect(p.avisos.map((a) => a.codigo)).toEqual(['requisito.no-cumple', 'requisito.no-cumple']);
			expect(p.avisos[0].remedio).toMatch(/Docker con root/);
			const r = await ajustes(`${P}-ssh-viejo`, { nombre: 'viejo2', 'p.puertoSsh': '2223' });
			expect(r).toMatchObject({ status: 303 });
			expect(await trampa(`${P}-ssh-viejo`)).toMatchObject({
				nombre: 'viejo2',
				parametros: { puertoSsh: 2223 }
			});
		});
	});
});
