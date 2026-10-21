import { describe, expect, it } from 'vitest';
import {
	compararVersiones,
	firmarEstado,
	firmarRelease,
	verificarRelease,
	firmarPeticion,
	generarClaves,
	verificarEstado,
	verificarPeticion,
	type EstadoDeseado
} from './index.ts';

const nodo = generarClaves();
const otro = generarClaves();
const panel = generarClaves();

describe('peticiones del nodo', () => {
	const firmar = (cuerpo = '{"v":1}', ahora = Date.now()) =>
		firmarPeticion(nodo.privada, 'nodo-mad01', 'POST', '/api/nodo/latido', cuerpo, ahora);
	const verificar = (
		c: Record<string, string>,
		cuerpo = '{"v":1}',
		vistas = new Map(),
		clave = nodo.publica
	) =>
		verificarPeticion(
			clave,
			{ fecha: c['x-fecha'], firma: c['x-firma'] },
			'POST',
			'/api/nodo/latido',
			cuerpo,
			vistas
		);

	it('una petición firmada por el nodo se acepta', () => {
		expect(verificar(firmar())).toEqual({ ok: true });
	});

	it('si cambia el cuerpo, la firma no vale', () => {
		expect(verificar(firmar(), '{"v":2}')).toEqual({ ok: false, motivo: 'firma no válida' });
	});

	it('firmada con la clave de otro nodo, no vale', () => {
		expect(verificar(firmar(), '{"v":1}', new Map(), otro.publica)).toMatchObject({ ok: false });
	});

	it('la misma petición no vale dos veces', () => {
		const c = firmar();
		const vistas = new Map();
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: true });
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: false, motivo: 'petición repetida' });
	});

	it('una petición vieja no vale', () => {
		const c = firmar('{"v":1}', Date.now() - 10 * 60_000);
		expect(verificar(c)).toEqual({ ok: false, motivo: 'fecha fuera de margen' });
	});
});

describe('estado deseado', () => {
	const estado = (cambios: Partial<EstadoDeseado> = {}): EstadoDeseado => ({
		version: 1,
		cliente: 'aldanza',
		versionObjetivo: '0.2.0',
		anillo: 'piloto',
		release: null,
		soporte: null,
		modulos: ['cowrie'],
		despliegueEnPausa: false,
		emitido: new Date().toISOString(),
		caduca: new Date(Date.now() + 3600_000).toISOString(),
		...cambios
	});

	it('el nodo acepta el estado firmado por el panel', () => {
		const r = verificarEstado(panel.publica, 'aldanza', firmarEstado(panel.privada, estado()));
		expect(r).toMatchObject({ ok: true, estado: { versionObjetivo: '0.2.0' } });
	});

	it('rechaza un estado firmado por otra clave, aunque venga del mismo sitio', () => {
		const r = verificarEstado(panel.publica, 'aldanza', firmarEstado(otro.privada, estado()));
		expect(r).toEqual({ ok: false, motivo: 'firma del panel no válida' });
	});

	it('rechaza un estado manipulado por el camino', () => {
		const f = firmarEstado(panel.privada, estado());
		const tocado = { ...f, estado: f.estado.replace('0.2.0', '9.9.9') };
		expect(verificarEstado(panel.publica, 'aldanza', tocado)).toMatchObject({ ok: false });
	});

	it('rechaza el estado de otro cliente', () => {
		const f = firmarEstado(panel.privada, estado({ cliente: 'bodegas' }));
		expect(verificarEstado(panel.publica, 'aldanza', f)).toEqual({
			ok: false,
			motivo: 'el estado es para otro cliente'
		});
	});

	it('rechaza un estado caducado', () => {
		const f = firmarEstado(
			panel.privada,
			estado({ caduca: new Date(Date.now() - 1000).toISOString() })
		);
		expect(verificarEstado(panel.publica, 'aldanza', f)).toEqual({
			ok: false,
			motivo: 'estado caducado'
		});
	});
});

describe('versiones firmadas', () => {
	const publicacion = generarClaves();
	const D = 'a'.repeat(64);
	const release = {
		version: '0.2.0',
		publicada: new Date().toISOString(),
		notas: 'x',
		servicios: { consola: `ghcr.io/kinomakino/consola@sha256:${D}` }
	};

	describe('con configuración del nodo (0.12)', () => {
		const conConfiguracion = {
			...release,
			actualizador: `ghcr.io/kinomakino/actualizador@sha256:${D}`,
			nodo: { ficheros: { 'compose.yml': 'services: {}\n', Caddyfile: 'x\n' } },
			sensorRemoto: { ficheros: { 'compose.yml': 'services: {}\n' } }
		};
		const firmar = (r: object) => firmarRelease(publicacion.privada, r as typeof release);

		it('se acepta bien formada', () => {
			expect(verificarRelease(publicacion.publica, firmar(conConfiguracion)).ok).toBe(true);
		});

		it.each([
			[
				'un fichero que no está en la lista',
				{ nodo: { ficheros: { 'compose.yml': '', '.env': 'X=1' } } }
			],
			['sin compose.yml', { nodo: { ficheros: { Caddyfile: 'x' } } }],
			['un fichero de más de 64 KB', { nodo: { ficheros: { 'compose.yml': 'x'.repeat(70_000) } } }],
			[
				'una variable mal formada',
				{ nodo: { ficheros: { 'compose.yml': '' }, entorno: { nuevas: { 'mal nombre': '1' } } } }
			],
			[
				'un valor con salto de línea',
				{ nodo: { ficheros: { 'compose.yml': '' }, entorno: { nuevas: { X: 'a\nB=2' } } } }
			],
			[
				'el Caddyfile en el sensor remoto',
				{ sensorRemoto: { ficheros: { 'compose.yml': '', Caddyfile: '' } } }
			]
		])('se rechaza con %s', (_, cambio) => {
			expect(
				verificarRelease(publicacion.publica, firmar({ ...conConfiguracion, ...cambio })).ok
			).toBe(false);
		});

		it('una versión con configuración tiene que traer el actualizador', () => {
			const { actualizador: _, ...sin } = conConfiguracion;
			expect(verificarRelease(publicacion.publica, firmar(sin)).ok).toBe(false);
		});
	});

	it('una versión firmada con la clave de publicación se acepta', () => {
		expect(
			verificarRelease(publicacion.publica, firmarRelease(publicacion.privada, release))
		).toMatchObject({
			ok: true
		});
	});

	it('el panel no puede firmar versiones: su clave no es la de publicación', () => {
		const r = verificarRelease(publicacion.publica, firmarRelease(panel.privada, release));
		expect(r).toEqual({ ok: false, motivo: 'la versión no está firmada por SeguridadSI' });
	});

	it('una imagen por etiqueta, sin digest, no vale aunque esté firmada', () => {
		const mala = { ...release, servicios: { consola: 'ghcr.io/kinomakino/consola:latest' } };
		expect(
			verificarRelease(publicacion.publica, firmarRelease(publicacion.privada, mala))
		).toMatchObject({
			ok: false
		});
	});

	it('cambiar una imagen después de firmar rompe la firma', () => {
		const f = firmarRelease(publicacion.privada, release);
		const tocada = { ...f, release: f.release.replace(D, 'b'.repeat(64)) };
		expect(verificarRelease(publicacion.publica, tocada)).toMatchObject({ ok: false });
	});

	it('las versiones se comparan como números, no como texto', () => {
		expect(compararVersiones('0.10.0', '0.9.0')).toBeGreaterThan(0);
		expect(compararVersiones('1.0.0', '1.0.0')).toBe(0);
	});
});
