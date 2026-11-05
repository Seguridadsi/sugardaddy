/*
 * El registro gratuito en un nodo Community, con firmas de verdad: qué desbloquea
 * una licencia de registro, qué no desbloquea nada, y que Cloud sigue igual. Las
 * dos claves son de usar y tirar. La base y el panel se simulan: el recorrido
 * completo contra Postgres está en herramientas/e2e/registro.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MODULOS_GRATIS,
	MODULOS_REGISTRO,
	codificarCodigo,
	firmarDelegacion,
	firmarLicencia,
	firmarLicenciaDelegada,
	generarClaves,
	type Delegacion,
	type Licencia,
	type LicenciaFirmada
} from '@sugardaddy/canal';

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env }));

/* Los ajustes como un mapa: lo único de la base que usa esto. */
const bd = vi.hoisted(() => ({ ajustes: new Map<string, unknown>(), auditoria: [] as unknown[] }));
vi.mock('./db', () => {
	const clave = { nombre: 'clave' };
	return {
		schema: { ajustes: { clave }, auditoria: { tabla: 'auditoria' } },
		db: {
			select: () => ({
				from: () => ({
					where: async (c: { clave: string }) =>
						bd.ajustes.has(c.clave) ? [{ valor: bd.ajustes.get(c.clave) }] : []
				})
			}),
			insert: (t: { tabla?: string }) => ({
				values: (v: { clave: string; valor: unknown }) => {
					if (t.tabla === 'auditoria') {
						bd.auditoria.push(v);
						return Promise.resolve();
					}
					return {
						onConflictDoUpdate: async () => {
							bd.ajustes.set(v.clave, v.valor);
						}
					};
				}
			})
		}
	};
});
vi.mock('drizzle-orm', async (original) => ({
	...(await original<typeof import('drizzle-orm')>()),
	eq: (_: unknown, clave: string) => ({ clave })
}));
vi.mock('./canal', () => ({
	urlPanelValida: () => true,
	gestionadoPorPanel: vi.fn(async () => false)
}));
vi.mock('./consultas', () => ({
	auditar: vi.fn(async () => {}),
	cabecera: async () => ({ cliente: { nombre: 'Prueba', nodo: 'n1', version: '1.0.0' } }),
	guardarAutoActualizar: vi.fn(async (_: string, v: unknown) => {
		bd.ajustes.set('auto-actualizar', v);
	})
}));

const { autorizados, porQueNo } = await import('./catalogo');
const { coberturaLicencia, modulosDeRegistro } = await import('./candado');
const { activar, estadoRegistro, renovar } = await import('./registro');
const canal = await import('./canal');

const AHORA = Date.parse('2026-11-05T10:00:00Z');
const dias = (n: number) => new Date(AHORA + n * 86_400_000).toISOString();
const kino = generarClaves();
const panel = generarClaves();
const otro = generarClaves();

const certificado = (caduca = dias(500), modulos = [...MODULOS_REGISTRO], msp = 'registro') => {
	const d: Delegacion = {
		tipo: 'delegacion-licencias',
		version: 1,
		msp,
		clavePublica: panel.publica,
		modulos,
		emitida: dias(-10),
		caduca
	};
	return firmarDelegacion(kino.privada, d);
};
const licencia = (l: Partial<Licencia> = {}): Licencia => ({
	tipo: 'licencia',
	version: 1,
	cliente: 'community-registro',
	nodo: 'community',
	nodoClave: 'AA==',
	modulos: [...MODULOS_REGISTRO],
	marca: 'r-prueba',
	emitida: dias(-1),
	caduca: dias(364),
	...l
});
const firmada = (l: Partial<Licencia> = {}, d = certificado()): LicenciaFirmada =>
	firmarLicenciaDelegada(panel.privada, licencia(l), d);
const TOKEN = 'a'.repeat(43);
const codigo = (f: LicenciaFirmada = firmada()) =>
	codificarCodigo({ licencia: f, token: TOKEN, correo: 'ana@ejemplo.es' });

beforeEach(() => {
	bd.ajustes.clear();
	bd.auditoria.length = 0;
	env.EDICION = 'community';
	env.PUBLICACION_CLAVE_PUBLICA = kino.publica;
	env.CLAVE_SECRETOS = 'ab'.repeat(32);
	vi.mocked(canal.gestionadoPorPanel).mockResolvedValue(false);
	vi.unstubAllGlobals();
});

describe('sin registro no se desbloquea nada', () => {
	it('solo las gratis; las de registro dicen que se activan con el registro', async () => {
		expect(new Set(await autorizados())).toEqual(new Set(MODULOS_GRATIS));
		const cubre = await coberturaLicencia();
		expect(cubre('cowrie')).toBe('cubierta');
		expect(cubre('smb')).toBe('registro.sin');
		expect(cubre('mysql')).toBe('licencia.sin');
		expect(porQueNo({ id: 'smb', incluida: false, licencia: cubre('smb') })).toBe(
			'Gratis con tu registro'
		);
		expect(porQueNo({ id: 'mysql', incluida: false, licencia: cubre('mysql') })).toBe(
			'Viene en Sugardaddy Cloud'
		);
	});

	it('sin clave de publicación: ni autoriza ni cubre, aunque haya licencia', async () => {
		delete env.PUBLICACION_CLAVE_PUBLICA;
		bd.ajustes.set('licencia', firmada());
		expect(await modulosDeRegistro()).toEqual([]);
		expect(new Set(await autorizados())).toEqual(new Set(MODULOS_GRATIS));
		const cubre = await coberturaLicencia();
		expect(cubre('smb')).toBe('registro.sin');
		expect(cubre('cowrie')).toBe('cubierta');
		const r = await activar('a@b.c', codigo(), AHORA);
		expect(r.ok).toBe(false);
		expect(bd.ajustes.has('registro')).toBe(false);
	});

	it.each([
		['otra clave de panel', () => firmarLicenciaDelegada(otro.privada, licencia(), certificado())],
		['sin certificado', () => firmarLicencia(panel.privada, licencia())],
		['firmada directamente con otra clave', () => firmarLicencia(otro.privada, licencia())],
		[
			'un certificado que no es de registro',
			() => firmada({}, certificado(dias(500), [...MODULOS_REGISTRO], 'msp-acme'))
		],
		[
			'un módulo de Cloud colado',
			() => firmada({ modulos: ['smb', 'mysql'] }, certificado(dias(500), ['smb', 'mysql']))
		],
		['caducada', () => firmada({ caduca: dias(-1), emitida: dias(-30) })],
		['certificado caducado', () => firmada({}, certificado(dias(-1)))]
	])('un código con %s se rechaza y no guarda nada', async (_, f) => {
		const r = await activar('a@b.c', codigo(f()), AHORA);
		expect(r.ok).toBe(false);
		expect(bd.ajustes.has('licencia')).toBe(false);
		expect(bd.ajustes.has('registro')).toBe(false);
		expect(bd.ajustes.has('auto-actualizar')).toBe(false);
	});

	it('una licencia manipulada no vale ni pegada ni guardada', async () => {
		const f = firmada({ modulos: ['smb'] });
		const tocada = { ...f, licencia: f.licencia.replace('"smb"', '"smb","rdp"') };
		expect((await activar('a@b.c', codigo(tocada), AHORA)).ok).toBe(false);
		bd.ajustes.set('licencia', tocada);
		expect(await modulosDeRegistro()).toEqual([]);
	});

	it('un texto que no es un código', async () => {
		expect((await activar('a@b.c', 'hola', AHORA)).ok).toBe(false);
		expect((await activar('a@b.c', 'SDR1.%%%', AHORA)).ok).toBe(false);
		expect((await activar('a@b.c', `SDR1.${'A'.repeat(20000)}`, AHORA)).ok).toBe(false);
	});
});

describe('con el código de activación', () => {
	it('desbloquea exactamente lo de registro y activa las actualizaciones', async () => {
		const r = await activar('admin@n.es', codigo(), AHORA);
		expect(r.ok).toBe(true);
		expect(new Set(await modulosDeRegistro())).toEqual(new Set(MODULOS_REGISTRO));
		const lista = new Set(await autorizados());
		for (const m of MODULOS_REGISTRO) expect(lista.has(m)).toBe(true);
		expect(lista.has('mysql')).toBe(false);
		const cubre = await coberturaLicencia();
		expect(cubre('smb')).toBe('cubierta');
		expect(cubre('mysql')).toBe('licencia.sin');
		expect(bd.ajustes.get('auto-actualizar')).toMatchObject({
			activo: true,
			correo: 'ana@ejemplo.es'
		});
		/* El token no se guarda en claro. */
		expect(JSON.stringify(bd.ajustes.get('registro'))).not.toContain(TOKEN);
		expect((await estadoRegistro(AHORA)).estado).toBe('vigente');
	});

	it('un nodo gestionado por un panel no se registra', async () => {
		vi.mocked(canal.gestionadoPorPanel).mockResolvedValue(true);
		expect((await activar('a@b.c', codigo(), AHORA)).ok).toBe(false);
		expect(bd.ajustes.has('licencia')).toBe(false);
	});

	it('un nodo de Cloud no se registra', async () => {
		delete env.EDICION;
		expect((await activar('a@b.c', codigo(), AHORA)).ok).toBe(false);
	});

	it('caducada: sigue autorizada para decir que ha caducado, pero no cubre', async () => {
		const f = firmada({ emitida: dias(-30), caduca: dias(-1) });
		bd.ajustes.set('licencia', f);
		bd.ajustes.set('registro', {
			correo: 'a@b.c',
			token: 'x',
			activado: dias(-30),
			renovada: null,
			fallo: null
		});
		expect(new Set(await modulosDeRegistro())).toEqual(new Set(MODULOS_REGISTRO));
		const cubre = await coberturaLicencia();
		expect(cubre('smb')).toBe('registro.caducado');
		expect(cubre('cowrie')).toBe('cubierta');
		expect((await estadoRegistro()).estado).toBe('caducada');
	});
});

describe('renovación', () => {
	const respuesta = (status: number, cuerpo: unknown = {}) =>
		vi.fn(async () => new Response(JSON.stringify(cuerpo), { status }));

	it('no llama al panel si no le toca', async () => {
		await activar('a@b.c', codigo(), AHORA);
		const f = respuesta(200, {});
		vi.stubGlobal('fetch', f);
		expect(await renovar(AHORA)).toBe('no-toca');
		expect(f).not.toHaveBeenCalled();
	});

	it('en el último tercio manda SOLO el token y guarda la licencia nueva', async () => {
		await activar('a@b.c', codigo(), AHORA);
		const tarde = AHORA + 300 * 86_400_000;
		const nueva = firmada({ emitida: dias(299), caduca: dias(650) });
		const f = respuesta(200, { licencia: nueva });
		vi.stubGlobal('fetch', f);
		expect(await renovar(tarde)).toBe('renovada');
		const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
		expect(bd.ajustes.get('licencia')).toEqual(nueva);
	});

	it.each([
		[
			'otra clave',
			() => firmarLicenciaDelegada(otro.privada, licencia({ caduca: dias(650) }), certificado())
		],
		[
			'un módulo de más',
			() => firmada({ modulos: ['mysql'], caduca: dias(650) }, certificado(dias(900), ['mysql']))
		],
		['nada', () => null]
	])('lo que devuelva el panel se verifica: %s no sustituye a la licencia', async (_, l) => {
		await activar('a@b.c', codigo(), AHORA);
		const antes = bd.ajustes.get('licencia');
		vi.stubGlobal('fetch', respuesta(200, { licencia: l() }));
		expect(await renovar(AHORA + 300 * 86_400_000)).toBe('invalida');
		expect(bd.ajustes.get('licencia')).toEqual(antes);
	});

	it('falla cerrado sin lanzar: panel caído, sin registro disponible o registro retirado', async () => {
		await activar('a@b.c', codigo(), AHORA);
		const antes = bd.ajustes.get('licencia');
		const tarde = AHORA + 300 * 86_400_000;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('sin red');
			})
		);
		expect(await renovar(tarde)).toBe('sin-conexion');
		vi.stubGlobal('fetch', respuesta(503));
		expect(await renovar(tarde)).toBe('no-disponible');
		vi.stubGlobal('fetch', respuesta(429));
		expect(await renovar(tarde)).toBe('no-toca');
		vi.stubGlobal('fetch', respuesta(404));
		expect(await renovar(tarde)).toBe('retirado');
		expect(bd.ajustes.get('licencia')).toEqual(antes);
		expect((await estadoRegistro(tarde)).fallo).toMatch(/retirado/);
	});
});

describe('Cloud no cambia', () => {
	beforeEach(() => {
		delete env.EDICION;
	});

	it('una licencia de Cloud que incluye las de registro las cubre, y dice Cloud si no', async () => {
		bd.ajustes.set(
			'licencia',
			firmarLicencia(
				kino.privada,
				licencia({
					cliente: 'acme',
					nodo: 'acme-1',
					marca: 'acme-7',
					modulos: ['mysql', ...MODULOS_REGISTRO],
					caduca: new Date(Date.now() + 86_400_000).toISOString(),
					emitida: new Date(Date.now() - 86_400_000).toISOString()
				})
			)
		);
		const cubre = await coberturaLicencia();
		for (const m of [...MODULOS_REGISTRO, 'mysql']) expect(cubre(m)).toBe('cubierta');
		expect(cubre('postgresql')).toBe('licencia.sin');
	});

	it('sin licencia, lo de registro también dice licencia (no registro)', async () => {
		const cubre = await coberturaLicencia();
		expect(cubre('smb')).toBe('licencia.sin');
		expect(porQueNo({ id: 'smb', incluida: true, licencia: 'licencia.sin' })).toBe(
			'No está en tu licencia de Cloud'
		);
	});

	it('sin clave para cotejar, sigue juzgándolo la trampa', async () => {
		delete env.PUBLICACION_CLAVE_PUBLICA;
		const cubre = await coberturaLicencia();
		expect(cubre('smb')).toBe('cubierta');
	});

	it('el registro no autoriza nada en un nodo de Cloud', async () => {
		bd.ajustes.set('licencia', firmada());
		expect(await autorizados()).toEqual([]);
	});
});
