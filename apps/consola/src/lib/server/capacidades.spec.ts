/*
 * Capacidades en la consola (docs/diseno/modulo-despliegue.md §4.3, §4.4 y
 * paso 6): lo que cuenta cada sensor de su máquina por las rutas de verdad
 * (plan y estado), cómo se guarda en sensores.capacidades y los hechos que
 * salen para su destino. Contra una base de datos de verdad (DATABASE_URL de
 * .env, como recepcion.spec.ts); si no hay, se salta.
 */
import { readFileSync } from 'node:fs';
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

const { elegir, leerCapacidades, leerHoneycosa } = await import('@sugardaddy/contrato');
const { avisosSensor, resumenMotor } = await import('$lib/capacidades');
const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { crearSensor } = hayBase ? await import('./gestion') : ({} as never);
const { crearDestino, destinoDeSensor, hechosDe } = hayBase
	? await import('./destinos')
	: ({} as never);
const { informarEstado, leerEstados, versionAgente } = hayBase
	? await import('./sensor')
	: ({} as never);
const rutaEstado = hayBase ? await import('../../routes/api/sensor/estado/+server') : null;
const rutaPlan = hayBase ? await import('../../routes/api/sensor/plan/+server') : null;
const { and, eq, like, or, sql } = await import('drizzle-orm');

const QUIEN = 'zz-prueba-capacidades';
/* Todo lo de esta prueba empieza por zz-cap: así se limpia sin tocar nada más. */
const P = 'zz-cap';
const tokens = new Map<string, string>();

async function limpiar() {
	await db.delete(s.trampas).where(like(s.trampas.id, `${P}%`));
	await db.delete(s.destinos).where(like(s.destinos.id, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
	await db
		.delete(s.auditoria)
		.where(or(eq(s.auditoria.quien, QUIEN), like(s.auditoria.quien, `sensor ${P}%`)));
}

/* Un sensor dado de alta como desde Sensores (con su destino) y una trampa suya. */
async function nuevoSensor(id: string) {
	const token = await crearSensor(QUIEN, { id, nombre: `Sensor ${id}`, segmento: 'pruebas' });
	tokens.set(id, token!);
	await db.insert(s.trampas).values({
		id: `${id}-ssh`,
		nombre: 'ssh',
		sensor: id,
		modulo: 'cowrie',
		tipo: 'contenedor',
		donde: 'desplegando…',
		parametros: {}
	});
}

const cabeceras = (id: string) => ({ authorization: `Bearer ${tokens.get(id)}` });

/* POST /api/sensor/estado, como lo manda el sensor. */
const estado = (id: string, cuerpo: unknown) =>
	rutaEstado!.POST({
		request: new Request('http://consola/api/sensor/estado', {
			method: 'POST',
			headers: { ...cabeceras(id), 'content-type': 'application/json' },
			body: JSON.stringify(cuerpo)
		})
	} as never);

/* GET /api/sensor/plan, con las cabeceras que se le pasen. */
const pedirPlan = (id: string, extra: Record<string, string> = {}) =>
	rutaPlan!.GET({
		request: new Request('http://consola/api/sensor/plan', {
			headers: { ...cabeceras(id), ...extra }
		})
	} as never);

const fila = async (id: string) =>
	(await db.select().from(s.sensores).where(eq(s.sensores.id, id)))[0];

/* Los hechos del destino de un sensor, como los verá el elector. */
async function hechos(id: string) {
	const d = await destinoDeSensor(id);
	expect(d).not.toBeNull();
	return hechosDe(d!, await fila(id));
}

/* xmin cambia con cada escritura de la fila: sirve para contarlas. */
const xmin = async (tabla: 'sensores' | 'trampas', id: string) =>
	(
		await db.execute<{ x: string }>(
			sql`select xmin::text as x from ${sql.identifier(tabla)} where id = ${id}`
		)
	)[0].x;

const lineasAuditoria = (id: string) =>
	db
		.select()
		.from(s.auditoria)
		.where(
			and(
				eq(s.auditoria.quien, `sensor ${id}`),
				eq(s.auditoria.accion, 'datos de la máquina descartados')
			)
		);

/* El cuerpo de un sensor 0.13.1, el de §4.4. */
const motor131 = {
	tipo: 'docker',
	modo: 'rootful',
	version: '27.3.1',
	api: '1.47',
	apiMotor: '1.47',
	apiMinima: '1.24',
	so: 'linux',
	arquitectura: 'amd64',
	sistema: 'Ubuntu 24.04.1 LTS',
	cgroups: '2',
	almacenamiento: 'overlay2',
	seguridad: ['name=apparmor', 'name=seccomp,profile=builtin'],
	memoria: 8589934592,
	cpus: 4,
	pasarelas: ['172.30.0.1', '172.31.0.1']
};
const cuerpo131 = (id: string, cambios: Record<string, unknown> = {}) => ({
	trampas: [{ id: `${id}-ssh`, donde: '0.0.0.0:22' }],
	motor: motor131,
	hechos: { 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' } },
	...cambios
});
const fallo = (id: string) => ({
	trampas: [
		{
			id: `${id}-ssh`,
			donde: 'error: motor.inalcanzable: el sensor no llega al motor',
			codigo: 'motor.inalcanzable'
		}
	],
	motor: { codigo: 'motor.inalcanzable', error: 'el sensor no llega al motor de contenedores' },
	hechos: { 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' } }
});

describe.skipIf(!hayBase)('capacidades en la consola', () => {
	beforeAll(async () => {
		await limpiar();
		for (const id of ['a', 'b', 'c', 'd', 'e']) await nuevoSensor(`${P}-${id}`);
	});
	afterAll(async () => {
		vi.restoreAllMocks();
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	const A = `${P}-a`;
	const B = `${P}-b`;
	const C = `${P}-c`;
	const D = `${P}-d`;
	const E = `${P}-e`;

	it('un sensor 0.12 deja las capacidades vacías; su destino tiene lo que pone la consola', async () => {
		expect((await pedirPlan(A, { 'sugardaddy-version': '0.12.3' })).status).toBe(200);
		const r = await estado(A, { trampas: [{ id: `${A}-ssh`, donde: '0.0.0.0:22' }] });
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ ok: true });
		const f = await fila(A);
		expect(f.capacidades).toBeNull();
		expect(f.versionAgente).toBe('0.12.3');
		expect(await hechos(A)).toEqual({
			'agente.ejecutores': {
				valor: ['contenedor@1'],
				motivo: 'agente.anterior',
				fuente: 'consola'
			},
			'agente.version': { valor: '0.12.3', fuente: 'consola' },
			'registro.privado': { valor: false, fuente: 'consola' }
		});
	});

	it('el elector ve a un sensor 0.12 como uno que no dice cómo es su máquina', async () => {
		const cowrie = leerHoneycosa(readFileSync('../../modulos/trampas/cowrie/trampa.yaml', 'utf8'));
		expect(cowrie.ok).toBe(true);
		await pedirPlan(A, { 'sugardaddy-version': '0.12.3', 'sugardaddy-registro': 'si' });
		const d = (await destinoDeSensor(A))!;
		const e = elegir({
			honeycosa: cowrie.ok ? cowrie.valor : (null as never),
			destino: {
				id: d.id,
				nombre: d.nombre,
				tipo: 'maquina',
				activo: true,
				agente: { sensor: A, vivo: true },
				hechos: await hechos(A)
			},
			parametros: { modo: 'sondeo' },
			contexto: {
				autorizado: true,
				ejecutoresConsola: ['contenedor@1', 'manual@1'],
				hechosNodo: {},
				trampasDelDestino: [],
				trampas: {}
			}
		});
		expect(e.elegida?.via).toBe('contenedor');
		expect(e.elegida?.avisos.map((a) => a.codigo)).toEqual(['agente.anterior']);
	});

	it('la versión del agente sale de la cabecera del plan; sin ella, o rara, no se sabe', async () => {
		await pedirPlan(A, { 'sugardaddy-version': '0.13.1' });
		expect((await fila(A)).versionAgente).toBe('0.13.1');
		expect((await hechos(A))['agente.version']).toEqual({ valor: '0.13.1', fuente: 'consola' });
		await pedirPlan(A, { 'sugardaddy-version': 'dev' });
		expect((await fila(A)).versionAgente).toBe('dev');
		await pedirPlan(A, { 'sugardaddy-version': '0.13.1; rm -rf /' });
		expect((await fila(A)).versionAgente).toBeNull();
		await pedirPlan(A, { 'sugardaddy-version': '0.13.1' });
		await pedirPlan(A);
		expect((await fila(A)).versionAgente).toBeNull();
		expect(await hechos(A)).not.toHaveProperty(['agente.version']);
		expect(versionAgente('0.13.1-rc1')).toBe('0.13.1-rc1');
		expect(versionAgente('x'.repeat(65))).toBeNull();
	});

	it('un sensor 0.13.1 da los hechos de su motor, plataforma.so y red.ipOrigenReal', async () => {
		expect((await estado(B, cuerpo131(B))).status).toBe(200);
		const { cuando } = (await fila(B)).capacidades!;
		const h = await hechos(B);
		const delSensor = { fuente: 'sensor', cuando };
		expect(h['motor.tipo']).toEqual({ valor: 'docker', ...delSensor });
		expect(h['motor.modo']).toEqual({ valor: 'rootful', ...delSensor });
		expect(h['motor.arquitectura']).toEqual({ valor: 'amd64', ...delSensor });
		expect(h['motor.version']).toEqual({ valor: '27.3.1', ...delSensor });
		expect(h['motor.pasarelas']).toEqual({ valor: ['172.30.0.1', '172.31.0.1'], ...delSensor });
		expect(h['motor.memoria']).toEqual({ valor: 8589934592, ...delSensor });
		expect(h['plataforma.so']).toEqual({ valor: 'linux', ...delSensor });
		expect(h['red.ipOrigenReal']).toEqual({ valor: true, motivo: 'origen.real', ...delSensor });
		/* Un 0.13.1 no dice qué ejecuta: lo sigue poniendo la consola. */
		expect(h['agente.ejecutores']).toEqual({
			valor: ['contenedor@1'],
			motivo: 'agente.anterior',
			fuente: 'consola'
		});
		expect(
			(
				await db
					.select()
					.from(s.trampas)
					.where(eq(s.trampas.id, `${B}-ssh`))
			)[0].donde
		).toBe('0.0.0.0:22');
	});

	it('con Docker Desktop, plataforma.so sale del formulario y no del motor', async () => {
		const d = (await destinoDeSensor(B))!;
		await db
			.update(s.destinos)
			.set({ descripcion: { so: 'windows', powershell: '5.1' } })
			.where(eq(s.destinos.id, d.id));
		await estado(B, cuerpo131(B, { motor: { ...motor131, modo: 'desktop' } }));
		let h = await hechos(B);
		expect(h['plataforma.so']).toEqual({ valor: 'windows', fuente: 'formulario' });
		expect(h['motor.so']).toMatchObject({ valor: 'linux', fuente: 'sensor' });
		expect(h['shell.powershell']).toEqual({ valor: '5.1', fuente: 'formulario' });
		/* Con el motor con root, manda el sensor. */
		await estado(B, cuerpo131(B));
		h = await hechos(B);
		expect(h['plataforma.so']).toMatchObject({ valor: 'linux', fuente: 'sensor' });
		expect(h['shell.powershell']).toEqual({ valor: '5.1', fuente: 'formulario' });
	});

	it('un destino sin sensor solo tiene lo del formulario', async () => {
		const id = await crearDestino(QUIEN, {
			nombre: `${P}-fs01`,
			tipo: 'fileserver',
			descripcion: { so: 'windows', powershell: '5.1', protocolos: ['smb'] }
		});
		const [d] = await db.select().from(s.destinos).where(eq(s.destinos.id, id));
		expect(hechosDe(d, null)).toEqual({
			'plataforma.so': { valor: 'windows', fuente: 'formulario' },
			'shell.powershell': { valor: '5.1', fuente: 'formulario' },
			'fileserver.protocolos': { valor: ['smb'], fuente: 'formulario' }
		});
	});

	it('las listas de la sonda de puertos: 3 puertos se guardan; 513 se descartan enteros', async () => {
		const sonda = (puertos: string[]) =>
			cuerpo131(B, {
				hechos: {
					'red.ipOrigenReal': { valor: true, motivo: 'origen.real' },
					'agente.ejecutores': { valor: ['contenedor@1'] },
					'agente.plataforma': { valor: 'linux-amd64' },
					'puertos.ocupados': { valor: puertos, motivo: 'puertos.sonda' },
					'red.direcciones': { valor: ['10.20.0.5'], motivo: 'puertos.sonda' }
				}
			});
		await estado(B, sonda(['tcp/22', 'tcp/443', 'udp/53']));
		expect((await fila(B)).capacidades!.hechos['puertos.ocupados']).toEqual({
			valor: ['tcp/22', 'tcp/443', 'udp/53'],
			motivo: 'puertos.sonda'
		});
		let h = await hechos(B);
		expect(h['puertos.ocupados']).toMatchObject({
			valor: ['tcp/22', 'tcp/443', 'udp/53'],
			fuente: 'sensor'
		});
		/* El sensor dice qué ejecuta: gana a lo que pone la consola. */
		expect(h['agente.ejecutores']).toMatchObject({ valor: ['contenedor@1'], fuente: 'sensor' });
		expect(h['agente.ejecutores']).not.toHaveProperty('motivo');
		expect(h['red.direcciones']).toMatchObject({ valor: ['10.20.0.5'] });

		await estado(B, sonda(Array.from({ length: 513 }, (_, i) => `tcp/${i + 1}`)));
		h = await hechos(B);
		expect(h).not.toHaveProperty(['puertos.ocupados']);
		expect(h['red.direcciones']).toMatchObject({ valor: ['10.20.0.5'] });
	});

	it('un fallo del motor conserva cómo está instalado y añade su código', async () => {
		await estado(C, cuerpo131(C));
		await estado(C, fallo(C));
		const conservado = {
			tipo: 'docker',
			modo: 'rootful',
			so: 'linux',
			arquitectura: 'amd64',
			codigo: 'motor.inalcanzable',
			error: 'el sensor no llega al motor de contenedores'
		};
		const c = (await fila(C)).capacidades!;
		expect(c.motor).toEqual(conservado);
		const h = await hechos(C);
		expect(h['motor.modo']).toMatchObject({ valor: 'rootful', fuente: 'sensor' });
		expect(h['motor.arquitectura']).toMatchObject({ valor: 'amd64', fuente: 'sensor' });
		expect(h['motor.codigo']).toMatchObject({ valor: 'motor.inalcanzable', fuente: 'sensor' });
		for (const k of ['motor.version', 'motor.api', 'motor.pasarelas', 'motor.sinGarantia'])
			expect(h).not.toHaveProperty([k]);
		/* La página Sensores sigue enseñando el fallo, y no el motor de antes. */
		expect(avisosSensor(c)[0]).toMatchObject({ codigo: 'motor.inalcanzable', gravedad: 'error' });
		expect(resumenMotor(c.motor)).toBeNull();
		/* Otro informe con el fallo: sigue igual. */
		await estado(C, fallo(C));
		expect((await fila(C)).capacidades!.motor).toEqual(conservado);
		/* Cuando vuelve el motor, todo lo que cuenta y sin el código. */
		await estado(C, cuerpo131(C));
		expect((await fila(C)).capacidades!.motor).toEqual(motor131);
		/* Sin nada de antes, solo el código y el texto. */
		await estado(D, fallo(D));
		expect((await fila(D)).capacidades!.motor).toEqual({
			codigo: 'motor.inalcanzable',
			error: 'el sensor no llega al motor de contenedores'
		});
	});

	it('100 estados iguales seguidos hacen una sola escritura', async () => {
		const c = cuerpo131(D);
		/* Directamente con informarEstado: la ruta escribe además el latido del sensor. */
		const informar = () =>
			informarEstado(D, structuredClone(c.trampas), leerCapacidades(structuredClone(c)));
		await informar();
		const sensor = await xmin('sensores', D);
		const trampa = await xmin('trampas', `${D}-ssh`);
		const { cuando } = (await fila(D)).capacidades!;
		for (let i = 0; i < 99; i++) await informar();
		expect(await xmin('sensores', D)).toBe(sensor);
		expect(await xmin('trampas', `${D}-ssh`)).toBe(trampa);
		expect((await fila(D)).capacidades!.cuando).toBe(cuando);

		/* Sin cambios, «cuando» se refresca como mucho cada 5 minutos. */
		const hace = (min: number) =>
			db
				.update(s.sensores)
				.set({
					capacidades: sql`jsonb_set(${s.sensores.capacidades}, '{cuando}', to_jsonb(${new Date(Date.now() - min * 60_000).toISOString()}::text))`
				})
				.where(eq(s.sensores.id, D));
		await hace(4);
		const a4 = await xmin('sensores', D);
		await informar();
		expect(await xmin('sensores', D)).toBe(a4);
		await hace(6);
		const a6 = await xmin('sensores', D);
		await informar();
		expect(await xmin('sensores', D)).not.toBe(a6);
		expect(Date.now() - Date.parse((await fila(D)).capacidades!.cuando)).toBeLessThan(60_000);

		/* Lo que cambia sí se escribe, y un sensor que deja de contar algo, también. */
		await informarEstado(
			D,
			c.trampas,
			leerCapacidades({ ...c, hechos: { 'red.ipOrigenReal': { valor: false } } })
		);
		expect((await fila(D)).capacidades!.hechos['red.ipOrigenReal']).toEqual({ valor: false });
		await informarEstado(D, c.trampas, leerCapacidades({ trampas: c.trampas }));
		expect((await fila(D)).capacidades).toBeNull();
		const vacio = await xmin('sensores', D);
		await informarEstado(D, c.trampas, leerCapacidades({ trampas: c.trampas }));
		expect(await xmin('sensores', D)).toBe(vacio);
	});

	it('un motor que es texto o unos hechos de 1 MB se ignoran, con una línea en la auditoría y 200', async () => {
		/* El sensor manda null cuando no sabe nada: no es un fallo. */
		expect((await estado(E, { trampas: [], motor: null, hechos: null })).status).toBe(200);
		expect(await lineasAuditoria(E)).toEqual([]);

		const r = await estado(E, {
			trampas: [{ id: `${E}-ssh`, donde: '0.0.0.0:22' }],
			motor: 'docker'
		});
		expect(r.status).toBe(200);
		expect((await fila(E)).capacidades).toBeNull();
		expect(
			(
				await db
					.select()
					.from(s.trampas)
					.where(eq(s.trampas.id, `${E}-ssh`))
			)[0].donde
		).toBe('0.0.0.0:22');
		let lineas = await lineasAuditoria(E);
		expect(lineas).toHaveLength(1);
		expect(lineas[0].detalle).toEqual({
			motivo: 'lo que cuenta de su motor de contenedores no tiene la forma esperada y se ignora'
		});

		/*
		 * 1 MB de hechos, cada uno con la forma buena (listas de 512 textos de 120
		 * caracteres): lo que no cabe en 32 KB no se guarda; lo demás, sí.
		 */
		const lista = (n: number) =>
			Array.from({ length: 512 }, (_, i) => `${n}-${i}-`.padEnd(120, 'x'));
		const mega = {
			trampas: [],
			motor: motor131,
			hechos: {
				'red.ipOrigenReal': { valor: true, motivo: 'origen.real' },
				...Object.fromEntries(
					Array.from({ length: 18 }, (_, n) => [`relleno.lista${n}`, { valor: lista(n) }])
				)
			}
		};
		expect(JSON.stringify(mega.hechos).length).toBeGreaterThan(1024 * 1024);
		expect((await estado(E, mega)).status).toBe(200);
		const c = (await fila(E)).capacidades!;
		expect(c.hechos).toEqual({ 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' } });
		expect(c.motor).toEqual(motor131);
		/* Dentro de la misma hora, ninguna línea más. */
		expect(await lineasAuditoria(E)).toHaveLength(1);

		/* Pasada la hora, otra. */
		const ahora = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(ahora + 61 * 60_000);
		try {
			expect((await estado(E, { ...mega, motor: 7 })).status).toBe(200);
		} finally {
			vi.restoreAllMocks();
		}
		lineas = await lineasAuditoria(E);
		expect(lineas).toHaveLength(2);
		expect(lineas.map((l) => l.detalle)).toContainEqual({
			motivo:
				'lo que cuenta de su motor de contenedores no tiene la forma esperada y se ignora; lo que cuenta de su máquina pasa de 32 KB y se descarta lo que sobra'
		});
		/* Unos hechos que no son un objeto no hacen fallar el informe. */
		expect((await estado(E, { trampas: [], hechos: 'muchos' })).status).toBe(200);
	});

	it('lee el código y los avisos de cada trampa para la colocación', () => {
		expect(
			leerEstados([
				{
					id: 't1',
					donde: 'error: motor.permiso: sin permiso',
					codigo: 'motor.permiso',
					avisos: ['aislamiento.se-ven', 'aislamiento.se-ven', 'imagen.descargando', '<script>', 3]
				},
				{ id: 't2', donde: '0.0.0.0:22', codigo: 'no es un código', avisos: 'aislamiento.se-ven' },
				{ id: 3, donde: 'x' },
				{ id: 't4' },
				null,
				'texto'
			])
		).toEqual([
			{
				id: 't1',
				donde: 'error: motor.permiso: sin permiso',
				codigo: 'motor.permiso',
				avisos: ['aislamiento.se-ven', 'imagen.descargando']
			},
			{ id: 't2', donde: '0.0.0.0:22' }
		]);
		const muchas = Array.from({ length: 150 }, (_, i) => ({ id: `t${i}`, donde: 'x'.repeat(300) }));
		const leidas = leerEstados(muchas);
		expect(leidas).toHaveLength(100);
		expect(leidas[0].donde).toHaveLength(200);
	});
});
