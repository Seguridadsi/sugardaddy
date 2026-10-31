/*
 * La vía manual en la consola (docs/diseno/modulo-despliegue.md §6.3, paso
 * 11): la ficha de una trampa a mano con sus pasos, sus descargas, «Ya está
 * hecho», «Retirar» y «Ya lo he quitado». Por las acciones y el load de las
 * rutas de verdad y contra una base de datos de verdad (DATABASE_URL de .env,
 * como recepcion.spec.ts); si no hay, se salta.
 *
 * El catálogo es uno de prueba (SUGARDADDY_MODULOS) con el ejemplo v2 de
 * credencial-ssh, que apunta a una copia de cowrie que solo existe aquí
 * (zz-man-ssh-modulo): así las Cowrie que haya en la base de datos de
 * desarrollo no cuentan como su objetivo.
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
/*
 * El candado de licencia (capa 4) tiene su propio banco (plan-licencia-base.spec):
 * aquí se prueba la vía manual, no la licencia, así que el nodo cuenta como
 * totalmente licenciado (sin esto, con PUBLICACION_CLAVE_PUBLICA en el .env y sin
 * licencia montada, las trampas de pago saldrían descartadas del plan).
 */
vi.mock('./candado', () => ({
	coberturaLicencia: async () => () => 'cubierta',
	licenciaGuardada: async () => null
}));
/* Todo autorizado: lo que se prueba aquí no depende de la suscripción. */
vi.mock('./catalogo', async (original) => {
	const catalogo = await original<typeof import('./catalogo')>();
	return {
		...catalogo,
		autorizados: async () => catalogo.honeycosas().map((h) => h.id),
		trampasAutorizadas: async () => catalogo.honeycosas()
	};
});

const { renderizar, sha256Pasos, validarParametros } = await import('@sugardaddy/contrato');
const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { crearDestino, editarDestino } = hayBase ? await import('./destinos') : ({} as never);
const { cambiarTrampa, crearSensor } = hayBase ? await import('./gestion') : ({} as never);
const { honeycosas } = hayBase ? await import('./catalogo') : ({} as never);
const { informarEstado, plan } = hayBase ? await import('./sensor') : ({} as never);
const { trampasConEventos, resumen } = hayBase ? await import('./consultas') : ({} as never);
const rutaTrampa = hayBase ? await import('../../routes/trampas/[id]/+page.server') : null;
const rutaAlta = hayBase ? await import('../../routes/trampas/nueva/[modulo]/+page.server') : null;
const rutaLista = hayBase ? await import('../../routes/trampas/+page.server') : null;
const rutaPasos = hayBase
	? await import('../../routes/trampas/[id]/pasos/[formato]/+server')
	: null;
const { and, eq, like, or } = await import('drizzle-orm');

const QUIEN = 'zz-prueba-manual';
/* Todo lo de esta prueba empieza por zz-man: así se limpia sin tocar nada más. */
const P = 'zz-man';
const LOCAL = `${P}-local`;
const WIN = `${P}-win`;
const SSH = `${P}-ssh-modulo`;
const OBJETIVO = `${P}-cowrie`;
const DIRECCION_LOCAL = '10.40.0.5';

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

const locals = (roles = ['admin']) => ({
	usuario: { nombre: 'Prueba', correo: QUIEN, roles },
	modoDesarrollo: false
});

/* Una acción de la ficha de una trampa: lo que devuelve, o el redirect o el error que lanza. */
async function accion(
	nombre: 'guardar' | 'hecho' | 'retirar' | 'quitado' | 'regenerar',
	id: string,
	campos: Record<string, string> = {},
	roles?: string[]
) {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos)) f.append(k, v);
	try {
		return await rutaTrampa!.actions[nombre]({
			params: { id },
			request: new Request(`http://consola/trampas/${id}`, { method: 'POST', body: f }),
			locals: locals(roles)
		} as never);
	} catch (e) {
		return e;
	}
}

/* El alta de un módulo: lo que devuelve, o el redirect o el error que lanza. */
async function alta(modulo: string, campos: Record<string, string>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos)) f.append(k, v);
	try {
		return await rutaAlta!.actions.default({
			params: { modulo },
			request: new Request(`http://consola/trampas/nueva/${modulo}`, { method: 'POST', body: f }),
			locals: locals()
		} as never);
	} catch (e) {
		return e;
	}
}
type Fallo = { status: number; data: { errores: string[]; motivos: { codigo: string }[] } };
const codigos = (r: unknown) => (r as Fallo).data.motivos.map((m) => m.codigo);

/* Una acción de la lista de Trampas. */
async function enLista(nombre: 'estado' | 'retirar', campos: Record<string, string>) {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos)) f.append(k, v);
	try {
		return await rutaLista!.actions[nombre]({
			request: new Request('http://consola/trampas', { method: 'POST', body: f }),
			locals: locals()
		} as never);
	} catch (e) {
		return e;
	}
}

/* Descargar unos pasos: la respuesta, o el error que lanza. */
async function descargar(id: string, formato: string, parte?: string, roles?: string[]) {
	const url = new URL(
		`http://consola/trampas/${id}/pasos/${formato}${parte ? `?parte=${parte}` : ''}`
	);
	try {
		return (await rutaPasos!.GET({
			params: { id, formato },
			url,
			locals: locals(roles)
		} as never)) as Response;
	} catch (e) {
		return e as { status: number; body: { message: string } };
	}
}

const ficha = async (id: string) => {
	const d = await rutaTrampa!.load({ params: { id } } as never);
	if (d.tipo !== 'manual') throw new Error(`${id} no es a mano`);
	return d;
};
const trampa = async (id: string) =>
	(await db.select().from(s.trampas).where(eq(s.trampas.id, id)))[0];
const auditoria = async (accion: string) =>
	db
		.select()
		.from(s.auditoria)
		.where(and(eq(s.auditoria.quien, QUIEN), eq(s.auditoria.accion, accion)));

describe.skipIf(!hayBase)('la vía manual en la consola', () => {
	const repo = join(process.cwd(), '../..');
	let carpeta = '';
	const credencialYaml = () =>
		readFileSync(
			join(repo, 'paquetes/contrato/src/ejemplos/credencial-ssh.v2.yaml'),
			'utf8'
		).replace('modulos: [cowrie]', `modulos: [${SSH}]`);
	const escribir = (id: string, yaml: string) => {
		mkdirSync(join(carpeta, 'trampas', id), { recursive: true });
		writeFileSync(join(carpeta, 'trampas', id, 'trampa.yaml'), yaml);
	};

	beforeAll(async () => {
		carpeta = mkdtempSync(join(tmpdir(), 'sd-manual-'));
		const cowrie = readFileSync(join(repo, 'modulos/trampas/cowrie/trampa.yaml'), 'utf8');
		escribir(SSH, cowrie.replace(/^id: cowrie$/m, `id: ${SSH}`));
		escribir('credencial-ssh', credencialYaml());
		process.env.SUGARDADDY_MODULOS = carpeta;

		await limpiar();
		/* Un sensor 0.13.1 en línea, con la dirección de su máquina en Destinos. */
		await crearSensor(QUIEN, { id: LOCAL, nombre: `Sensor ${LOCAL}`, red: null, vlan: null });
		await db
			.update(s.sensores)
			.set({ ultimoLatido: new Date(), versionAgente: '0.13.1', registroPrivado: true })
			.where(eq(s.sensores.id, LOCAL));
		await informarEstado(LOCAL, [], {
			motor: { tipo: 'docker', modo: 'rootful', so: 'linux', arquitectura: 'amd64' },
			hechos: {}
		});
		await db
			.update(s.destinos)
			.set({ descripcion: { direccion: DIRECCION_LOCAL } })
			.where(eq(s.destinos.sensor, LOCAL));
		await crearDestino(QUIEN, {
			nombre: WIN,
			tipo: 'maquina',
			descripcion: { so: 'windows', edicion: 'puesto', powershell: '5.1' }
		});
		/* La trampa SSH a la que apuntan las credenciales: puesta y comprobada. */
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
	afterAll(async () => {
		delete process.env.SUGARDADDY_MODULOS;
		if (carpeta) rmSync(carpeta, { recursive: true, force: true });
		if (hayBase && !process.env.CONSERVAR) await limpiar();
	});

	describe('la ficha de una trampa a mano', () => {
		const ID = `${P}-a-mano`;

		/* Una credencial en WIN con sus pasos ya generados, como la deja el alta. */
		beforeAll(async () => {
			const h = honeycosas().find((x) => x.id === 'credencial-ssh')!;
			const p = validarParametros(h.parametros, {
				objetivo: OBJETIVO,
				usuario: 'svc_sql4k7',
				sesion: 'nas42'
			});
			if (!p.ok) throw new Error(p.errores.join('; '));
			const r = renderizar(h, 'windows', p.valor, {
				trampa: { id: ID, nombre: 'Credencial de win' },
				destino: { id: WIN, nombre: WIN },
				trampas: { [OBJETIVO]: { direccion: DIRECCION_LOCAL, parametros: { puertoSsh: 2231 } } },
				generado: new Date().toISOString()
			});
			if (!r.ok) throw new Error(r.errores.join('; '));
			await db.insert(s.trampas).values({
				id: ID,
				nombre: 'Credencial de win',
				modulo: 'credencial-ssh',
				tipo: 'identidad',
				sensor: LOCAL,
				destino: WIN,
				via: 'windows',
				ejecutor: 'manual@1',
				parametros: p.valor,
				donde: 'pasos a mano',
				manual: r.valor,
				senalTrampa: OBJETIVO
			});
		});

		it('sus acciones tienen nombre: SvelteKit no admite también la de por defecto', () => {
			expect(Object.keys(rutaTrampa!.actions)).not.toContain('default');
		});

		it('enseña el bloque de variables y los pasos guardados, con quién recibe su señal', async () => {
			const d = await ficha(ID);
			expect(d).toMatchObject({
				trampa: { id: ID, nombre: 'Credencial de win', colocacion: 'por-colocar' },
				destino: { id: WIN, nombre: WIN },
				objetivo: { id: OBJETIVO, nombre: 'Cowrie de local' },
				estado: { estado: 'por-colocar', motivo: 'Aún no se ha dicho que esté puesta.' }
			});
			const p = d.pasos!;
			expect(p).toMatchObject({
				lenguaje: 'powershell',
				via: 'Pasos para Windows',
				integros: true,
				formatos: ['ps1', 'md', 'txt'],
				marca: 'el usuario «svc_sql4k7»'
			});
			expect(p.bloque.split('\n')).toEqual([
				'$sd = @{',
				/* La usa el texto de su prueba. */
				`  'destino_nombre' = '${WIN}'`,
				`  'objetivo_direccion' = '${DIRECCION_LOCAL}'`,
				"  'objetivo_puertoSsh' = '2231'",
				"  'sesion' = 'nas42'",
				"  'usuario' = 'svc_sql4k7'",
				'}'
			]);
			expect(p.pasos[0].texto).toBe(
				`Guarda en el perfil del usuario una sesión de PuTTY «nas42» hacia ${DIRECCION_LOCAL}.`
			);
			expect(p.retirada[0].texto).toBe('Borra la sesión «nas42» de PuTTY.');
		});

		it('el .ps1 descargado tiene BOM y el sha256 de lo guardado, y deja su línea en la auditoría', async () => {
			const guardados = (await trampa(ID)).manual!;
			const r = (await descargar(ID, 'ps1')) as Response;
			expect(r.status).toBe(200);
			expect(r.headers.get('content-disposition')).toBe(
				`attachment; filename="sugardaddy-${ID}-colocar.ps1"`
			);
			const bytes = new Uint8Array(await r.arrayBuffer());
			expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			const texto = new TextDecoder().decode(bytes);
			expect(texto).toContain(`sha256 ${guardados.sha256}\r\n`);
			expect(sha256Pasos(guardados)).toBe(guardados.sha256);
			expect((await auditoria('pasos descargados')).map((a) => a.detalle)).toEqual([
				{ id: ID, formato: 'ps1', parte: 'colocar', pasos: guardados.sha256 }
			]);
			/* El documento para el control de cambios, también. */
			expect(((await descargar(ID, 'md')) as Response).status).toBe(200);
			/* Un script en otro lenguaje no existe, y quien solo mira no descarga. */
			expect(await descargar(ID, 'sh')).toMatchObject({ status: 404 });
			expect(await descargar(ID, 'ps1', 'probar')).toMatchObject({ status: 400 });
			expect(await descargar(ID, 'ps1', undefined, ['lector'])).toMatchObject({ status: 403 });
		});

		it('unos pasos que ya no cuadran con su huella no se descargan', async () => {
			const guardados = (await trampa(ID)).manual!;
			await db
				.update(s.trampas)
				.set({ manual: { ...guardados, variables: { ...guardados.variables, usuario: 'otro' } } })
				.where(eq(s.trampas.id, ID));
			try {
				expect((await ficha(ID)).pasos!.integros).toBe(false);
				expect(await descargar(ID, 'ps1')).toMatchObject({ status: 409 });
			} finally {
				await db.update(s.trampas).set({ manual: guardados }).where(eq(s.trampas.id, ID));
			}
		});

		it('no se para: lo que se siembra a mano no se pausa', async () => {
			expect(await cambiarTrampa(QUIEN, ID, false)).toBe('no-se-para');
			expect(await enLista('estado', { id: ID, activo: 'no' })).toMatchObject({ status: 400 });
			expect(await trampa(ID)).toMatchObject({ activo: true });
			const [x] = (await trampasConEventos()).filter((t) => t.id === ID);
			expect(x).toMatchObject({ aMano: true, pausable: false, destinoNombre: WIN });
		});

		it('nunca entra en el plan del sensor que recibe su señal', async () => {
			const x = await plan(LOCAL, true, '0.13.1');
			expect(x.trampas.map((t) => t.id)).toEqual([OBJETIVO]);
			expect(x.descartados).toEqual([]);
			/* En Inicio sale con ese sensor, diciendo en qué destino está. */
			const r = await resumen();
			expect(r.sensores.find((y) => y.id === LOCAL)?.trampas).toContainEqual(
				expect.objectContaining({ id: ID, aMano: true, destino: WIN })
			);
		});

		it('«Ya está hecho» la deja puesta y apunta quién y cuándo', async () => {
			const antes = Date.now();
			expect(await accion('hecho', ID, {}, ['lector'])).toMatchObject({ status: 403 });
			expect(await accion('hecho', ID)).toMatchObject({ hecho: expect.stringMatching(/puesta/) });
			expect(await trampa(ID)).toMatchObject({ colocacion: 'colocada', colocacionMotivo: null });
			const [a] = await auditoria('trampa puesta a mano');
			expect(a.quien).toBe(QUIEN);
			expect(a.cuando.getTime()).toBeGreaterThanOrEqual(antes - 1000);
			expect(a.detalle).toEqual({
				id: ID,
				nombre: 'Credencial de win',
				destino: WIN,
				pasos: (await trampa(ID)).manual!.sha256
			});
			expect((await ficha(ID)).estado).toMatchObject({ estado: 'colocada' });
			/* Ya puesta, no vuelve a estarlo. */
			expect(await accion('hecho', ID)).toMatchObject({ status: 400 });
		});

		it('«Ya lo he quitado» solo después de «Retirar»', async () => {
			expect(await accion('quitado', ID)).toMatchObject({ status: 400 });
			expect(await trampa(ID)).toBeDefined();
		});

		it('retirar la deja retirando, con sus pasos de retirada, y «Ya lo he quitado» la borra', async () => {
			expect(await accion('retirar', ID)).toMatchObject({
				hecho: expect.stringMatching(/Ya lo he quitado/)
			});
			expect(await trampa(ID)).toMatchObject({
				colocacion: 'retirando',
				colocacionMotivo: 'retirada.pendiente'
			});
			const d = await ficha(ID);
			expect(d.estado).toMatchObject({ estado: 'retirando', codigo: 'retirada.pendiente' });
			const r = (await descargar(ID, 'ps1', 'retirar')) as Response;
			expect(r.headers.get('content-disposition')).toMatch(/-retirar\.ps1"$/);
			expect(await r.text()).toContain('Borra la sesión «nas42» de PuTTY.');
			/* Retirar otra vez no cambia nada; desde la lista, tampoco. */
			expect(await enLista('retirar', { id: ID })).toMatchObject({
				mensaje: expect.stringMatching(/Ya lo he quitado/)
			});
			expect(await auditoria('trampa en retirada')).toHaveLength(1);

			const fuera = await accion('quitado', ID);
			expect(fuera).toMatchObject({
				status: 303,
				location: '/trampas?quitada=Credencial%20de%20win'
			});
			expect(await trampa(ID)).toBeUndefined();
			const [a] = await auditoria('trampa retirada');
			expect(a.detalle).toMatchObject({ id: ID, modulo: 'credencial-ssh', destino: WIN });
		});
	});

	describe('el alta de una trampa a mano', () => {
		const CRED = `${P}-cred`;
		/* Los campos del alta de una credencial en WIN que apunta a la Cowrie de local. */
		const credencial = (cambios: Record<string, string> = {}) => ({
			id: CRED,
			nombre: 'Credencial de win',
			destino: WIN,
			via: 'windows',
			'p.objetivo': OBJETIVO,
			'p.usuario': 'svc_sql4k7',
			'p.sesion': 'nas42',
			...cambios
		});

		it('con credencial-ssh y un destino Windows, los pasos llevan los datos del destino y del objetivo', async () => {
			const r = await alta('credencial-ssh', credencial());
			expect(r).toMatchObject({ status: 303, location: `/trampas/${CRED}` });
			const t = await trampa(CRED);
			expect(t).toMatchObject({
				modulo: 'credencial-ssh',
				tipo: 'identidad',
				ejecutor: 'manual@1',
				via: 'windows',
				destino: WIN,
				/* Recibe su señal el sensor de la Cowrie: sus eventos son los de ella. */
				sensor: LOCAL,
				senalTrampa: OBJETIVO,
				donde: 'pasos a mano',
				colocacion: 'por-colocar',
				parametros: { objetivo: OBJETIVO, usuario: 'svc_sql4k7', sesion: 'nas42' }
			});
			const m = t.manual!;
			expect(m).toMatchObject({
				trampa: CRED,
				destino: WIN,
				via: 'windows',
				lenguaje: 'powershell',
				nombres: { trampa: 'Credencial de win', destino: WIN, via: 'Pasos para Windows' },
				variables: {
					destino_nombre: WIN,
					objetivo_direccion: DIRECCION_LOCAL,
					objetivo_puertoSsh: '2231',
					usuario: 'svc_sql4k7',
					sesion: 'nas42'
				},
				marca: { campo: 'origen.usuario', igual: 'svc_sql4k7' }
			});
			expect(m.pasos[0].texto).toBe(
				`Guarda en el perfil del usuario una sesión de PuTTY «nas42» hacia ${DIRECCION_LOCAL}.`
			);
			expect(sha256Pasos(m)).toBe(m.sha256);
			/*
			 * En la auditoría, la huella de los pasos y lo que hace falta para
			 * quitarla: si una consola anterior borra la fila tras una vuelta
			 * atrás, los pasos de retirada siguen ahí (§9.1).
			 */
			const [a] = await auditoria('trampa creada');
			expect(a.detalle).toMatchObject({
				id: CRED,
				destino: WIN,
				via: 'windows',
				pasos: m.sha256,
				retirar: { lenguaje: 'powershell', variables: m.variables, pasos: m.retirada }
			});
			expect(a.detalle).not.toHaveProperty('manual');
			/* El .ps1 que se descarga es lo guardado: BOM y el mismo sha256. */
			const ps1 = new Uint8Array(await ((await descargar(CRED, 'ps1')) as Response).arrayBuffer());
			expect([...ps1.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			expect(new TextDecoder().decode(ps1)).toContain(`sha256 ${m.sha256}`);
			/* Y nunca entra en el plan. */
			expect((await plan(LOCAL, true, '0.13.1')).trampas.map((x) => x.id)).not.toContain(CRED);
		});

		it('en una máquina Linux, los pasos de Linux, en sh', async () => {
			const id = `${P}-cred-linux`;
			const r = await alta(
				'credencial-ssh',
				credencial({
					id,
					nombre: 'Credencial de local',
					destino: LOCAL,
					via: '',
					'p.usuario': 'bkp_admin2x'
				})
			);
			expect(r).toMatchObject({ status: 303 });
			expect((await trampa(id)).manual).toMatchObject({
				via: 'linux',
				lenguaje: 'sh',
				variables: { objetivo_direccion: DIRECCION_LOCAL, usuario: 'bkp_admin2x' }
			});
			expect((await ficha(id)).pasos!.formatos).toEqual(['sh', 'md', 'txt']);
			await db.update(s.trampas).set({ senalTrampa: null }).where(eq(s.trampas.id, id));
			await db.delete(s.trampas).where(eq(s.trampas.id, id));
		});

		it('la misma marca contra la misma Cowrie no se puede guardar dos veces', async () => {
			const r = await alta(
				'credencial-ssh',
				credencial({ id: `${P}-cred-2`, nombre: 'Otra', destino: LOCAL, via: 'linux' })
			);
			expect(r).toMatchObject({ status: 400 });
			expect(codigos(r)).toEqual(['senal.marca-repetida']);
			expect(await trampa(`${P}-cred-2`)).toBeUndefined();
		});

		it('un nombre que no puede ir en los pasos vuelve como parametros.invalidos', async () => {
			const r = await alta(
				'credencial-ssh',
				credencial({ id: `${P}-cred-3`, nombre: 'Credencial\u0007', 'p.usuario': 'svc_veeam9z' })
			);
			expect(r).toMatchObject({ status: 400 });
			expect(codigos(r)).toEqual(['parametros.invalidos']);
			expect((r as { data: { motivos: { texto: string }[] } }).data.motivos[0].texto).toMatch(
				/Nombre de la trampa: lleva saltos de línea o caracteres de control/
			);
		});

		it('en el formulario, cada Cowrie sale con su motivo si no vale', async () => {
			const otra = `${P}-cowrie-pendiente`;
			await db.insert(s.trampas).values({
				id: otra,
				nombre: 'Cowrie pendiente',
				modulo: SSH,
				tipo: 'contenedor',
				sensor: LOCAL,
				destino: LOCAL,
				parametros: { puertoSsh: 2232 },
				donde: 'desplegando…'
			});
			try {
				const url = new URL(`http://consola/trampas/nueva/credencial-ssh?destino=${WIN}`);
				const f = (await rutaAlta!.load({ params: { modulo: 'credencial-ssh' }, url } as never))
					.forma!;
				expect(f.objetivos.objetivo).toEqual([
					{ id: OBJETIVO, nombre: 'Cowrie de local', destino: `Sensor ${LOCAL}`, motivo: null },
					{
						id: otra,
						nombre: 'Cowrie pendiente',
						destino: `Sensor ${LOCAL}`,
						motivo: 'aún no está puesta'
					}
				]);
				/* Guardar con ella, el elector lo vuelve a mirar: no vale. */
				const r = await alta(
					'credencial-ssh',
					credencial({ id: `${P}-cred-4`, 'p.objetivo': otra, 'p.usuario': 'svc_sql9q1' })
				);
				expect(codigos(r)).toEqual(['senal.trampa-objetivo']);
			} finally {
				await db.delete(s.trampas).where(eq(s.trampas.id, otra));
			}
		});

		it('mientras no está puesta, cambiar sus datos vuelve a generar los pasos', async () => {
			const antes = (await trampa(CRED)).manual!;
			expect((await ficha(CRED)).cambiar).toMatchObject({
				valores: { objetivo: OBJETIVO, usuario: 'svc_sql4k7', sesion: 'nas42' }
			});
			const r = await accion('guardar', CRED, {
				nombre: 'Credencial de win',
				'p.objetivo': OBJETIVO,
				'p.usuario': 'svc_sql4k7',
				'p.sesion': 'nas43'
			});
			expect(r).toMatchObject({ hecho: expect.stringMatching(/de nuevo/) });
			const t = await trampa(CRED);
			expect(t.parametros).toMatchObject({ sesion: 'nas43' });
			expect(t.manual!.variables.sesion).toBe('nas43');
			expect(t.manual!.sha256).not.toBe(antes.sha256);
			const [a] = await auditoria('pasos generados de nuevo');
			expect(a.detalle).toMatchObject({
				id: CRED,
				pasos: t.manual!.sha256,
				antes: antes.sha256,
				retirar: { variables: { sesion: 'nas43' }, pasos: t.manual!.retirada }
			});
		});

		it('si la Cowrie cambia antes de ponerla, avisa y «Volver a generar los pasos» los rehace', async () => {
			/* Lo que no deja hacer la consola (§8.4) pero puede dejar una vuelta atrás. */
			await db
				.update(s.trampas)
				.set({ parametros: { puertoSsh: 2299 } })
				.where(eq(s.trampas.id, OBJETIVO));
			try {
				const e = (await ficha(CRED)).estado!;
				expect(e.estado).toBe('por-colocar');
				expect(e.avisos.map((a) => a.codigo)).toEqual(['senal.objetivo-cambiado']);
				expect(await accion('regenerar', CRED)).toMatchObject({
					hecho: expect.stringMatching(/de nuevo/)
				});
				expect((await trampa(CRED)).manual!.variables.objetivo_puertoSsh).toBe('2299');
				expect((await ficha(CRED)).estado!.avisos).toEqual([]);
			} finally {
				await db
					.update(s.trampas)
					.set({ parametros: { puertoSsh: 2231 } })
					.where(eq(s.trampas.id, OBJETIVO));
				await accion('regenerar', CRED);
			}
		});

		it('ya puesta, no se cambia: se retira y se pone otra', async () => {
			expect(await accion('hecho', CRED)).toMatchObject({ hecho: expect.any(String) });
			expect((await ficha(CRED)).cambiar).toBeNull();
			const r = await accion('guardar', CRED, {
				nombre: 'Credencial de win',
				'p.objetivo': OBJETIVO,
				'p.usuario': 'svc_sql4k7',
				'p.sesion': 'nas44'
			});
			expect(r).toMatchObject({ status: 400 });
			expect((r as Fallo).data.errores).toEqual([expect.stringMatching(/Retírala y pon otra/)]);
			expect((await trampa(CRED)).manual!.variables.sesion).toBe('nas43');
		});

		it('retirar enseña los pasos generados al ponerla, aunque el módulo haya cambiado después', async () => {
			const guardados = (await trampa(CRED)).manual!;
			/* SeguridadSI publica otra versión del módulo con otros pasos de retirada. */
			escribir(
				'credencial-ssh',
				credencialYaml()
					.replace('Borra la sesión «${sesion}» de PuTTY.', 'Otra forma de borrar «${sesion}».')
					.replace('versionModulo: 0.1.0', 'versionModulo: 0.2.0')
			);
			try {
				expect(honeycosas().find((h) => h.id === 'credencial-ssh')?.versionModulo).toBe('0.2.0');
				expect(await accion('retirar', CRED)).toMatchObject({ hecho: expect.any(String) });
				const p = (await ficha(CRED)).pasos!;
				expect(p.versionModulo).toBe('0.1.0');
				expect(p.retirada.map((x) => x.texto)).toEqual(['Borra la sesión «nas43» de PuTTY.']);
				expect(p.sha256).toBe(guardados.sha256);
				const r = (await descargar(CRED, 'ps1', 'retirar')) as Response;
				const texto = await r.text();
				expect(texto).toContain('Borra la sesión «nas43» de PuTTY.');
				expect(texto).not.toContain('Otra forma');
				expect(await accion('quitado', CRED)).toMatchObject({ status: 303 });
				expect(await trampa(CRED)).toBeUndefined();
			} finally {
				escribir('credencial-ssh', credencialYaml());
			}
		});

		it('dar de alta una credencial mientras se retira su Cowrie: espera y lo dice, sin error', async () => {
			const otra = `${P}-cowrie-carrera`;
			await db.insert(s.trampas).values({
				id: otra,
				nombre: 'Cowrie de la carrera',
				modulo: SSH,
				tipo: 'contenedor',
				sensor: LOCAL,
				destino: LOCAL,
				parametros: { puertoSsh: 2233 },
				donde: '0.0.0.0:2233',
				colocacion: 'comprobada',
				comprobada: new Date()
			});
			/* Otra transacción la tiene bloqueada para borrarla, como retirarTrampa. */
			let soltar!: () => void;
			const suelta = new Promise<void>((r) => (soltar = r));
			let bloqueada!: () => void;
			const yaBloqueada = new Promise<void>((r) => (bloqueada = r));
			const retirada = db.transaction(async (tx) => {
				await tx.select().from(s.trampas).where(eq(s.trampas.id, otra)).for('update');
				bloqueada();
				await suelta;
				await tx.delete(s.trampas).where(eq(s.trampas.id, otra));
			});
			await yaBloqueada;
			const r = alta(
				'credencial-ssh',
				credencial({ id: `${P}-cred-carrera`, 'p.objetivo': otra, 'p.usuario': 'svc_sql7c3' })
			);
			/* El alta espera a que acabe, y entonces ve que ya no está. */
			await new Promise((x) => setTimeout(x, 300));
			soltar();
			await retirada;
			expect(codigos(await r)).toEqual(['senal.trampa-objetivo']);
			expect(await trampa(`${P}-cred-carrera`)).toBeUndefined();
		});
	});

	describe('la trampa a la que apunta una credencial', () => {
		const CRED = `${P}-cred-dep`;
		beforeAll(async () => {
			expect(
				await alta('credencial-ssh', {
					id: CRED,
					nombre: 'Credencial de pc01',
					destino: WIN,
					via: 'windows',
					'p.objetivo': OBJETIVO,
					'p.usuario': 'svc_backup5r2',
					'p.sesion': 'fs07'
				})
			).toMatchObject({ status: 303 });
		});

		it('no se para: la lista dice qué credenciales apuntan a ella', async () => {
			expect(await cambiarTrampa(QUIEN, OBJETIVO, false)).toEqual({
				dependientes: ['Credencial de pc01']
			});
			expect(await enLista('estado', { id: OBJETIVO, activo: 'no' })).toMatchObject({
				status: 400,
				data: {
					error:
						'«Credencial de pc01» apunta a esta trampa: si la paras, dejaría de avisar. Retírala primero.'
				}
			});
			expect(await trampa(OBJETIVO)).toMatchObject({ activo: true, colocacion: 'comprobada' });
		});

		it('no se le cambia el puerto con que se generó la credencial; el nombre, sí', async () => {
			const r = await accion('guardar', OBJETIVO, {
				nombre: 'Cowrie de local',
				'p.puertoSsh': '2244'
			});
			expect(r).toMatchObject({ status: 400 });
			expect((r as Fallo).data.errores).toEqual([
				'«Credencial de pc01» apunta a esta trampa con su «Puerto SSH»: si lo cambias, dejaría de avisar. Retírala primero o deja ese ajuste como estaba.'
			]);
			expect(await trampa(OBJETIVO)).toMatchObject({ parametros: { puertoSsh: 2231 } });
			/* Con el mismo puerto, el resto se cambia. */
			expect(
				await accion('guardar', OBJETIVO, { nombre: 'Cowrie de la sala', 'p.puertoSsh': '2231' })
			).toMatchObject({ status: 303 });
			expect(await trampa(OBJETIVO)).toMatchObject({ nombre: 'Cowrie de la sala' });
			await db
				.update(s.trampas)
				.set({ nombre: 'Cowrie de local', donde: '0.0.0.0:2231' })
				.where(eq(s.trampas.id, OBJETIVO));
		});

		it('no se cambia la dirección de su destino; su nombre, sí', async () => {
			const [d] = await db.select().from(s.destinos).where(eq(s.destinos.sensor, LOCAL));
			expect(
				await editarDestino(QUIEN, d.id, {
					nombre: d.nombre,
					descripcion: { direccion: '10.40.0.99' },
					bloqueados: []
				})
			).toEqual({ dependientes: ['Credencial de pc01'] });
			expect(
				await editarDestino(QUIEN, d.id, {
					nombre: `${d.nombre} (sala)`,
					descripcion: { direccion: DIRECCION_LOCAL },
					bloqueados: []
				})
			).toBe('editado');
			await db.update(s.destinos).set({ nombre: d.nombre }).where(eq(s.destinos.id, d.id));
		});

		it('retirada la credencial, ya se para', async () => {
			expect(await accion('retirar', CRED)).toMatchObject({ hecho: expect.any(String) });
			/* Mientras se retira, lo sembrado sigue ahí: tampoco. */
			expect(await cambiarTrampa(QUIEN, OBJETIVO, false)).toEqual({
				dependientes: ['Credencial de pc01']
			});
			expect(await accion('quitado', CRED)).toMatchObject({ status: 303 });
			expect(await cambiarTrampa(QUIEN, OBJETIVO, false)).toBe('hecho');
			expect(await cambiarTrampa(QUIEN, OBJETIVO, true)).toBe('hecho');
		});
	});
});
