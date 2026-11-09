import { describe, expect, it } from 'vitest';
import {
	edicionDeRelease,
	compararVersiones,
	direccionReleValida,
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
		expect(verificar(firmar(), '{"v":2}')).toEqual({ ok: false, motivo: 'invalid signature' });
	});

	it('firmada con la clave de otro nodo, no vale', () => {
		expect(verificar(firmar(), '{"v":1}', new Map(), otro.publica)).toMatchObject({ ok: false });
	});

	it('la misma petición no vale dos veces', () => {
		const c = firmar();
		const vistas = new Map();
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: true });
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: false, motivo: 'repeated request' });
	});

	it('tampoco escribiendo la misma firma de otra forma', () => {
		const c = firmar();
		const vistas = new Map();
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: true });
		const firma = c['x-firma'] as string;
		for (const otra of [
			firma.replace(/=+$/, ''),
			`${firma}=`,
			firma.replace(/\+/g, '-').replace(/\//g, '_'),
			` ${firma}`
		])
			expect(verificar({ ...c, 'x-firma': otra }, '{"v":1}', vistas), otra).toEqual({
				ok: false,
				motivo: 'repeated request'
			});
	});

	it('una petición vieja no vale', () => {
		const c = firmar('{"v":1}', Date.now() - 10 * 60_000);
		expect(verificar(c)).toEqual({ ok: false, motivo: 'date out of range' });
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
		expect(r).toEqual({ ok: false, motivo: 'invalid Central signature' });
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
			motivo: 'the state is for another customer'
		});
	});

	it('rechaza un estado caducado', () => {
		const f = firmarEstado(
			panel.privada,
			estado({ caduca: new Date(Date.now() - 1000).toISOString() })
		);
		expect(verificarEstado(panel.publica, 'aldanza', f)).toEqual({
			ok: false,
			motivo: 'the state has expired'
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
		expect(r).toEqual({ ok: false, motivo: 'the version is not signed by SeguridadSI' });
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

describe('la dirección del relé', () => {
	it.each(['rele-de-prueba.azurewebsites.net', 'rele.neutro.example', 'a1.xn--bcher-kva.example'])(
		'%s es un nombre limpio',
		(d) => {
			expect(direccionReleValida(d)).toBe(true);
		}
	);

	it.each([
		'',
		'localhost',
		'10.0.0.1',
		'1.2.3.4.5',
		'http://rele.example',
		'https://rele.example',
		'ftp://rele.example',
		'javascript:alert(1)',
		'rele.example/b/x',
		'rele.example?x=1',
		'rele.example#x',
		'rele.example:8443',
		'user@rele.example',
		'rele.example.',
		'.rele.example',
		'rele..example',
		'-rele.example',
		'rele-.example',
		'RELE.EXAMPLE',
		' rele.example',
		'rele.example ',
		'rele.example\n',
		'rele.example\nx: y',
		'rele example.com',
		'relé.example',
		`${'a'.repeat(64)}.example`,
		`${'a.'.repeat(130)}example`
	])('%j no entra en un documento', (d) => {
		expect(direccionReleValida(d)).toBe(false);
	});

	it.each([null, undefined, 1, {}, ['rele.example']])('%j no es una dirección', (d) => {
		expect(direccionReleValida(d)).toBe(false);
	});

	it('viaja firmada y los nodos anteriores la ignoran: el estado se verifica igual', () => {
		const base: EstadoDeseado = {
			version: 1,
			cliente: 'acme',
			versionObjetivo: '0.1.0',
			release: null,
			anillo: 'general',
			despliegueEnPausa: false,
			soporte: null,
			modulos: [],
			emitido: new Date().toISOString(),
			caduca: new Date(Date.now() + 60_000).toISOString()
		};
		const conRele = verificarEstado(
			panel.publica,
			'acme',
			firmarEstado(panel.privada, { ...base, rele: 'rele.example' })
		);
		expect(conRele).toMatchObject({ ok: true, estado: { rele: 'rele.example' } });
		const sinRele = verificarEstado(panel.publica, 'acme', firmarEstado(panel.privada, base));
		expect(sinRele.ok && 'rele' in sinRele.estado).toBe(false);
		/* Cambiarla por el camino invalida la firma. */
		const f = firmarEstado(panel.privada, { ...base, rele: 'rele.example' });
		const trucada = { ...f, estado: f.estado.replace('rele.example', 'otro.example') };
		expect(verificarEstado(panel.publica, 'acme', trucada).ok).toBe(false);
	});
});

describe('edicionDeRelease (SUP-3)', () => {
	const r = (servicios: Record<string, string>, actualizador?: string) => ({
		servicios,
		actualizador
	});
	it('Cloud: todas las imágenes del registro privado de Azure', () => {
		expect(
			edicionDeRelease(
				r(
					{ consola: 'ejemplo.azurecr.io/sugardaddy-consola@sha256:1' },
					'ejemplo.azurecr.io/sugardaddy-actualizador@sha256:2'
				)
			)
		).toBe('cloud');
	});
	it('Community: alguna de ghcr.io', () => {
		expect(
			edicionDeRelease(
				r(
					{ consola: 'ghcr.io/seguridadsi/sugardaddy-consola@sha256:1' },
					'ejemplo.azurecr.io/sugardaddy-actualizador@sha256:2'
				)
			)
		).toBe('community');
	});
	it('desarrollo o vacía: ni una ni otra', () => {
		expect(edicionDeRelease(r({ consola: 'localhost:5000/sugardaddy-consola@sha256:1' }))).toBe(
			null
		);
		expect(edicionDeRelease(r({}))).toBe(null);
	});
});
