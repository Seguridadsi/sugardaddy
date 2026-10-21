/*
 * La página Destinos (docs/diseno/modulo-despliegue.md §5.3 y paso 7): el
 * formulario corto, los hechos de cada destino con su fuente, «Qué puedes
 * poner aquí», «Instalar un sensor aquí», editar y dar de baja. Por las
 * acciones de las rutas de verdad y contra una base de datos de verdad
 * (DATABASE_URL de .env, como recepcion.spec.ts); si no hay, se salta.
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
/* La línea de un sensor remoto: sin CA propia (certificado de una CA de confianza) y con HTTPS. */
process.env.TLS_MODO = 'ficheros';
process.env.ORIGIN = 'https://consola.prueba';
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));
/* Lo que autoriza el panel: aquí, solo cowrie. */
vi.mock('./catalogo', async (original) => ({
	...(await original<typeof import('./catalogo')>()),
	autorizados: async () => ['cowrie']
}));

const { avisosSensor } = await import('$lib/capacidades');
const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { crearSensor } = hayBase ? await import('./gestion') : ({} as never);
const { crearDestino, edicionDestino, fichaDestino, leerFormulario, listaDestinos } = hayBase
	? await import('./destinos')
	: ({} as never);
const { informarEstado } = hayBase ? await import('./sensor') : ({} as never);
const rutaNuevo = hayBase ? await import('../../routes/destinos/nuevo/+page.server') : null;
const rutaFicha = hayBase ? await import('../../routes/destinos/[id]/+page.server') : null;
const { and, eq, like, or } = await import('drizzle-orm');

const QUIEN = 'zz-prueba-pagina-destinos';
/* Todo lo de esta prueba empieza por zz-pd: así se limpia sin tocar nada más. */
const P = 'zz-pd';
const FS01 = `${P}-fs01`;

async function limpiar() {
	const mias = like(s.trampas.id, `${P}%`);
	await db.update(s.trampas).set({ senalTrampa: null }).where(mias);
	await db.delete(s.trampas).where(mias);
	await db
		.delete(s.destinos)
		.where(or(like(s.destinos.id, `${P}%`), like(s.destinos.sensor, `${P}%`)));
	await db.delete(s.instaladoresSensor).where(like(s.instaladoresSensor.sensor, `${P}%`));
	await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
	await db
		.delete(s.auditoria)
		.where(or(eq(s.auditoria.quien, QUIEN), like(s.auditoria.quien, `sensor ${P}%`)));
}

const locals = (roles = ['admin']) => ({
	usuario: { nombre: 'Prueba', correo: QUIEN, roles },
	modoDesarrollo: false
});

function formulario(campos: Record<string, string | string[]>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos))
		for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
	return f;
}

const peticion = (campos: Record<string, string | string[]>) =>
	new Request('http://consola/destinos', { method: 'POST', body: formulario(campos) });

/* Una acción de SvelteKit: lo que devuelve, o el redirect o el error que lanza. */
async function accion(
	ruta: { actions: Record<string, (e: never) => unknown> } | null,
	nombre: string,
	id: string | undefined,
	campos: Record<string, string | string[]> = {},
	roles?: string[]
) {
	try {
		return await ruta!.actions[nombre]({
			params: { id },
			request: peticion(campos),
			locals: locals(roles)
		} as never);
	} catch (e) {
		return e;
	}
}

/* El cuerpo de §4.4 de un sensor 0.13.1, con lo que se le cambie. */
function estado013(motor: Record<string, unknown> = {}, hechos: Record<string, unknown> = {}) {
	return {
		motor: {
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
			pasarelas: ['172.30.0.1', '172.31.0.1'],
			...motor
		},
		hechos: { 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' }, ...hechos }
	};
}

/* Un sensor dado de alta como desde Sensores, en línea y con lo que cuente de su máquina. */
async function sensorCon(id: string, capacidades: ReturnType<typeof estado013>) {
	await crearSensor(QUIEN, { id, nombre: `Sensor ${id}`, segmento: 'pruebas' });
	await db.update(s.sensores).set({ ultimoLatido: new Date() }).where(eq(s.sensores.id, id));
	await informarEstado(id, [], capacidades);
}

const hecho = async (destino: string, clave: string) =>
	(await fichaDestino(destino))!.hechos.find((h) => h.clave === clave);

describe.skipIf(!hayBase)('la página Destinos', () => {
	beforeAll(limpiar);
	afterAll(async () => {
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	it('crear fs01 (servidor de ficheros, Windows, PowerShell 5.1) lo enseña con lo del formulario', async () => {
		const r = await accion(rutaNuevo, 'default', undefined, {
			nombre: FS01,
			tipo: 'fileserver',
			so: 'windows',
			version: '10.0.17763',
			powershell: '5.1',
			posix: 'bash',
			direccion: '10.20.0.7',
			protocolos: ['smb']
		});
		expect(r).toMatchObject({ status: 303, location: `/destinos/${FS01}?creado` });
		const [d] = await db.select().from(s.destinos).where(eq(s.destinos.id, FS01));
		/* Un Windows no tiene shell POSIX: esa respuesta no se lee. */
		expect(d).toMatchObject({
			tipo: 'fileserver',
			sensor: null,
			descripcion: {
				so: 'windows',
				version: '10.0.17763',
				powershell: '5.1',
				direccion: '10.20.0.7',
				protocolos: ['smb']
			}
		});
		/* Con su nombre y su valor para el cliente, los mismos que dicen los motivos del elector. */
		expect(await hecho(FS01, 'plataforma.so')).toEqual({
			clave: 'plataforma.so',
			valor: 'windows',
			fuente: 'formulario',
			nombre: 'Sistema operativo',
			texto: 'Windows'
		});
		expect(await hecho(FS01, 'shell.powershell')).toMatchObject({
			valor: '5.1',
			fuente: 'formulario'
		});
		expect((await listaDestinos()).find((x) => x.id === FS01)).toMatchObject({
			nombre: FS01,
			tipo: 'fileserver',
			sensor: null,
			plataforma: 'Windows Server 2019',
			trampas: 0,
			avisos: []
		});
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, 'destino creado')));
		expect(a.detalle).toMatchObject({ id: FS01, tipo: 'fileserver' });
	});

	it('el formulario rechaza lo que no cuadra y no crea nada', async () => {
		const r = await accion(rutaNuevo, 'default', undefined, {
			nombre: 'malo‮',
			tipo: 'impresora',
			direccion: '10.0.0.1 ; rm'
		});
		expect(r).toMatchObject({ status: 400 });
		expect((r as { data: { errores: string[] } }).data.errores).toEqual([
			'Qué es: elige una opción de la lista.',
			'Nombre: sin saltos de línea ni caracteres invisibles.'
		]);
		const v = (campos: Record<string, string | string[]>, tipo = 'maquina') =>
			leerFormulario(formulario({ nombre: 'x', ...campos }), tipo);
		expect(v({}).errores).toEqual(['Sistema operativo: obligatorio.']);
		expect(v({ so: 'windows', version: '22.04' }).errores).toEqual([
			'Versión: elige una de la lista.'
		]);
		/* Un puesto no puede ser Windows Server 2019. */
		expect(v({ so: 'windows', edicion: 'puesto', version: '10.0.17763' }).errores).toEqual([
			'Versión: elige una de la lista.'
		]);
		expect(v({ so: 'linux', version: '22.04', posix: 'zsh' }).errores).toEqual([
			'Shell: elige una opción de la lista.'
		]);
		expect(v({ so: 'linux', version: 'jammy' }).errores).toEqual([
			'Versión: números separados por puntos, como 22.04.'
		]);
		expect(v({ so: 'linux', direccion: 'a b' }).errores).toEqual([
			'Dirección: una IP o un nombre de máquina, sin espacios.'
		]);
		expect(v({ so: 'nas', protocolos: ['smb', 'afp'] }, 'fileserver').errores).toEqual([
			'Protocolos: elige de la lista.'
		]);
		/* Un tipo de los «solo otro corto» solo pregunta el nombre; «otro», también el texto libre. */
		expect(v({ so: 'windows', direccion: '10.0.0.1' }, 'tenant')).toEqual({
			nombre: 'x',
			descripcion: {},
			errores: []
		});
		expect(v({ nota: 'La impresora de la planta 2' }, 'otro').descripcion).toEqual({
			nota: 'La impresora de la planta 2'
		});
		expect(await db.select().from(s.destinos).where(like(s.destinos.nombre, 'malo%'))).toEqual([]);
	});

	it('quien no despliega no puede crear destinos', async () => {
		const r = await accion(rutaNuevo, 'default', undefined, { nombre: `${P}-x` }, ['lector']);
		expect(r).toMatchObject({ status: 403 });
	});

	it('una máquina con sensor 0.13.1 enseña los hechos del motor y los avisos de avisosSensor', async () => {
		const id = `${P}-local`;
		await sensorCon(
			id,
			estado013({}, { 'red.ipOrigenReal': { valor: false, motivo: 'origen.pasarela' } })
		);
		const f = (await fichaDestino(id))!;
		const de = (clave: string) => f.hechos.find((h) => h.clave === clave);
		expect(de('motor.modo')).toMatchObject({ valor: 'rootful', fuente: 'sensor' });
		expect(de('motor.arquitectura')).toMatchObject({ valor: 'amd64', fuente: 'sensor' });
		expect(de('plataforma.so')).toMatchObject({ valor: 'linux', fuente: 'sensor' });
		expect(de('red.ipOrigenReal')).toMatchObject({
			valor: false,
			motivo: 'origen.pasarela',
			fuente: 'sensor'
		});
		expect(de('motor.modo')?.cuando).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(de('agente.ejecutores')).toMatchObject({ valor: ['contenedor@1'], fuente: 'consola' });
		const [x] = await db.select().from(s.sensores).where(eq(s.sensores.id, id));
		expect(f.avisos).toEqual(avisosSensor(x.capacidades));
		expect(f.avisos.map((a) => a.codigo)).toEqual(['origen.pasarela']);
		expect(f.plataforma).toBe('Ubuntu 24.04.1 LTS');
		expect(f.sensor).toMatchObject({ id, vivo: true });
		expect((await listaDestinos()).find((d) => d.id === id)?.avisos).toEqual(f.avisos);
	});

	it('«Qué puedes poner aquí» da cowrie con agente.falta en fs01 y válida en una máquina con sensor', async () => {
		const enFs01 = (await fichaDestino(FS01))!.queCabe;
		expect(enFs01.map((m) => m.modulo)).toEqual(['cowrie']);
		expect(enFs01[0]).toMatchObject({
			elegida: null,
			motivo: { codigo: 'agente.falta' },
			vias: [{ via: 'contenedor', vale: false, motivos: [{ codigo: 'agente.falta' }] }]
		});
		/* Windows: el remedio es la appliance. */
		expect(enFs01[0].motivo?.remedio).toMatch(/appliance/);

		/* Con la IP del motor observada no vale; cuando llega la real, sí. */
		const local = `${P}-local`;
		expect((await fichaDestino(local))!.queCabe[0]).toMatchObject({
			elegida: null,
			motivo: { codigo: 'requisito.no-cumple' }
		});
		await informarEstado(local, [], estado013());
		expect((await fichaDestino(local))!.queCabe[0]).toMatchObject({
			modulo: 'cowrie',
			elegida: { via: 'contenedor', nombre: 'En un sensor', avisos: [] },
			motivo: null,
			vias: [{ via: 'contenedor', vale: true, motivos: [] }]
		});
	});

	it('«Instalar un sensor aquí» deja fs01 con sensor sin crear otro destino, y lo del formulario sigue valiendo', async () => {
		/* Solo los de esta prueba: las demás pruebas crean y borran destinos a la vez. */
		const mios = async () => (await listaDestinos()).filter((d) => d.id.startsWith(P)).length;
		const antes = await mios();
		const r = await accion(rutaFicha, 'instalar', FS01, {
			id: `${P}-fs01-sensor`,
			nombre: 'Sensor de fs01',
			segmento: '10.20.0.0/24'
		});
		expect(r).toMatchObject({ para: `${P}-fs01-sensor` });
		expect((r as { linea: string }).linea).toMatch(
			/^curl -fsSL https:\/\/consola\.prueba\/instalar-sensor\/[A-Za-z0-9_-]{32} \| sudo bash$/
		);
		expect(await mios()).toBe(antes);
		const [d] = await db.select().from(s.destinos).where(eq(s.destinos.id, FS01));
		expect(d.sensor).toBe(`${P}-fs01-sensor`);
		/* Antes de que el sensor cuente nada, todo sigue siendo del formulario. */
		expect(await hecho(FS01, 'plataforma.so')).toMatchObject({
			valor: 'windows',
			fuente: 'formulario'
		});
		/* Cuando cuenta su máquina, manda en lo suyo; lo demás sigue del formulario. */
		await informarEstado(`${P}-fs01-sensor`, [], estado013());
		expect(await hecho(FS01, 'plataforma.so')).toMatchObject({ valor: 'linux', fuente: 'sensor' });
		for (const [clave, valor] of [
			['shell.powershell', '5.1'],
			['destino.direccion', '10.20.0.7'],
			['plataforma.version', '10.0.17763']
		])
			expect(await hecho(FS01, clave)).toMatchObject({ valor, fuente: 'formulario' });
	});

	it('en un destino que ya tiene sensor no se instala otro, y no queda el sensor', async () => {
		const r = await accion(rutaFicha, 'instalar', FS01, {
			id: `${P}-intruso`,
			nombre: 'Intruso',
			segmento: 'x'
		});
		expect(r).toMatchObject({ status: 409, data: { accion: 'instalar' } });
		expect(
			await db
				.select()
				.from(s.sensores)
				.where(eq(s.sensores.id, `${P}-intruso`))
		).toEqual([]);
		/* Y solo quien administra la consola da de alta sensores, como en Sensores. */
		const fs02 = await crearDestino(QUIEN, { nombre: `${P}-fs02`, tipo: 'maquina' });
		const o = await accion(
			rutaFicha,
			'instalar',
			fs02,
			{ id: `${P}-fs02`, nombre: 'x', segmento: 'y' },
			['operador']
		);
		expect(o).toMatchObject({ status: 403 });
	});

	it('con un sensor en Docker Desktop la ficha deja editar el sistema; con uno rootful, no', async () => {
		const desk = `${P}-desk`;
		await sensorCon(desk, estado013({ modo: 'desktop' }));
		expect((await fichaDestino(desk))!.formulario.bloqueados).toEqual([]);
		expect(await edicionDestino(desk)).toMatchObject({ tipo: 'maquina', bloqueados: [] });
		const r = await accion(rutaFicha, 'editar', desk, {
			nombre: 'Portátil de Ana',
			so: 'windows',
			edicion: 'puesto',
			version: '10.0.22000',
			powershell: '7.0'
		});
		expect(r).toEqual({ accion: 'editar', mensaje: 'Cambios guardados.' });
		expect(await hecho(desk, 'plataforma.so')).toMatchObject({
			valor: 'windows',
			fuente: 'formulario'
		});
		expect((await fichaDestino(desk))!.nombre).toBe('Portátil de Ana');

		const local = `${P}-local`;
		const f = (await fichaDestino(local))!;
		expect(f.formulario).toMatchObject({
			bloqueados: ['so'],
			delSensor: { so: 'linux' },
			so: 'linux'
		});
		const x = await accion(rutaFicha, 'editar', local, {
			nombre: 'Sensor local',
			so: 'windows',
			powershell: '5.1',
			posix: 'bash'
		});
		expect(x).toMatchObject({ mensaje: 'Cambios guardados.' });
		/* El sistema lo sigue diciendo el sensor; el shell es el de un Linux. */
		const [d] = await db.select().from(s.destinos).where(eq(s.destinos.id, local));
		expect(d.descripcion).toEqual({ posix: 'bash' });
		expect(await hecho(local, 'plataforma.so')).toMatchObject({ valor: 'linux', fuente: 'sensor' });
	});

	it('cambiar la dirección se niega si una trampa de aquí recibe la señal de otra', async () => {
		const sensor = `${P}-local`;
		const cow = await crearDestino(QUIEN, {
			nombre: `${P}-cow`,
			tipo: 'maquina',
			descripcion: { so: 'linux', direccion: '10.30.0.5' }
		});
		await db.insert(s.trampas).values([
			{
				id: `${P}-t-cowrie`,
				nombre: 'Cowrie de cow',
				modulo: 'cowrie',
				tipo: 'contenedor',
				sensor,
				destino: cow,
				donde: '-'
			},
			{
				id: `${P}-t-cred`,
				nombre: 'Credencial de fs01',
				modulo: 'credencial-ssh',
				tipo: 'identidad',
				sensor,
				destino: FS01,
				via: 'windows',
				ejecutor: 'manual@1',
				senalTrampa: `${P}-t-cowrie`,
				donde: '-'
			}
		]);
		const r = await accion(rutaFicha, 'editar', cow, {
			nombre: `${P}-cow`,
			so: 'linux',
			direccion: '10.30.0.6'
		});
		expect(r).toMatchObject({
			status: 400,
			data: {
				errores: [
					'La trampa «Credencial de fs01» apunta a la dirección de este destino: retírala primero.'
				]
			}
		});
		expect(await hecho(cow, 'destino.direccion')).toMatchObject({ valor: '10.30.0.5' });
		/* El nombre sí se puede cambiar. */
		const n = await accion(rutaFicha, 'editar', cow, {
			nombre: 'Servidor SSH',
			so: 'linux',
			direccion: '10.30.0.5'
		});
		expect(n).toMatchObject({ mensaje: 'Cambios guardados.' });
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, 'destino modificado')))
			.orderBy(s.auditoria.id);
		expect(a.detalle).toMatchObject({ id: `${P}-desk`, nombre: 'Portátil de Ana' });
	});

	it('dar de baja se niega con trampas o con sensor, y sin nada lo borra', async () => {
		const cow = `${P}-cow`;
		expect(await accion(rutaFicha, 'baja', cow)).toMatchObject({
			status: 400,
			data: { accion: 'baja', error: 'Retira antes sus trampas.' }
		});
		expect(await accion(rutaFicha, 'baja', `${P}-local`)).toMatchObject({
			status: 400,
			data: { error: 'Este destino tiene sensor: se da de baja retirando su sensor, en Sensores.' }
		});
		expect(await accion(rutaFicha, 'baja', `${P}-fs02`)).toMatchObject({
			status: 303,
			location: '/destinos?baja'
		});
		expect(
			await db
				.select()
				.from(s.destinos)
				.where(eq(s.destinos.id, `${P}-fs02`))
		).toEqual([]);
		expect(await accion(rutaFicha, 'baja', `${P}-fs02`)).toMatchObject({ status: 404 });
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, 'destino dado de baja')));
		expect(a.detalle).toEqual({ id: `${P}-fs02`, nombre: `${P}-fs02`, tipo: 'maquina' });
		expect(
			(await db.select().from(s.destinos).where(eq(s.destinos.id, cow))).map((d) => d.id)
		).toEqual([cow]);
	});

	it('la ficha de un destino que no existe da 404', async () => {
		await expect(
			rutaFicha!.load({ params: { id: `${P}-no` }, url: new URL('http://c/') } as never)
		).rejects.toMatchObject({ status: 404 });
	});
});
