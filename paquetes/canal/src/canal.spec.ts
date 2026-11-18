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
	cabecerasDe,
	comprobarPeticion,
	ultimoEmitidoTras,
	type EstadoDeseado
} from './index.ts';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { firmadoPorPanel } from './panel.ts';

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
			cabecerasDe(new Headers(c)),
			'POST',
			'/api/nodo/latido',
			cuerpo,
			vistas
		);

	it('una petición firmada por el nodo se acepta', () => {
		expect(verificar(firmar())).toEqual({ ok: true, legado: false });
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
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: true, legado: false });
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: false, motivo: 'repeated request' });
	});

	it('tampoco escribiendo la misma firma de otra forma', () => {
		const c = firmar();
		const vistas = new Map();
		expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: true, legado: false });
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
	/* Auditoría 2026-11-14, «canal firmado»: el nodo dentro de la cadena canónica. */
	describe('el nodo dentro de lo firmado (x-firma-2)', () => {
		it('cambiar x-nodo rompe la firma nueva, aunque los dos nodos compartieran clave', () => {
			const c = firmar();
			expect(verificar({ ...c, 'x-nodo': 'nodo-bcn02' })).toEqual({
				ok: false,
				motivo: 'invalid signature'
			});
		});

		it('si viene la firma nueva y no cuadra, no se cae a la vieja', () => {
			const c = firmar();
			const otraFirma2 = firmarPeticion(
				otro.privada,
				'nodo-mad01',
				'POST',
				'/api/nodo/latido',
				'{"v":1}'
			);
			expect(verificar({ ...c, 'x-firma-2': otraFirma2['x-firma-2'] })).toEqual({
				ok: false,
				motivo: 'invalid signature'
			});
		});

		it('quitar x-firma-2 a una petición ya aceptada no la hace pasar otra vez', () => {
			const c = firmar();
			const vistas = new Map();
			expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: true, legado: false });
			const { 'x-firma-2': _quitada, ...sinNueva } = c;
			expect(verificar(sinNueva, '{"v":1}', vistas)).toEqual({
				ok: false,
				motivo: 'repeated request'
			});
		});

		it('las huellas que hay que apuntar son las dos firmas', () => {
			const v = comprobarPeticion(
				nodo.publica,
				cabecerasDe(new Headers(firmar())),
				'POST',
				'/api/nodo/latido',
				'{"v":1}'
			);
			expect(v).toMatchObject({ ok: true, legado: false });
			expect(v.ok && v.huellas.length).toBe(2);
		});

		it('exigirNodo rechaza la firma vieja sola (para cuando no quede ningún nodo anterior)', () => {
			const { 'x-firma-2': _q, ...viejo } = firmar();
			expect(
				comprobarPeticion(
					nodo.publica,
					cabecerasDe(new Headers(viejo)),
					'POST',
					'/api/nodo/latido',
					'{"v":1}',
					Date.now(),
					{ exigirNodo: true }
				)
			).toEqual({ ok: false, motivo: 'old signature format' });
		});
	});

	/*
	 * Compatibilidad: así firmaba un nodo hasta la 0.31 (solo x-nodo, x-fecha y x-firma, sobre
	 * método, ruta, fecha y sha256 del cuerpo). El panel nuevo lo sigue aceptando y lo cuenta.
	 */
	describe('compatibilidad con los nodos anteriores', () => {
		const firmarComoAntes = (cuerpo = '{"v":1}', ahora = Date.now()) => {
			const fecha = new Date(ahora).toISOString();
			const h = createHash('sha256').update(cuerpo).digest('hex');
			const clave = createPrivateKey({
				key: Buffer.from(nodo.privada, 'base64'),
				format: 'der',
				type: 'pkcs8'
			});
			const firma = sign(null, Buffer.from(`POST\n/api/nodo/latido\n${fecha}\n${h}`), clave);
			return { 'x-nodo': 'nodo-mad01', 'x-fecha': fecha, 'x-firma': firma.toString('base64') };
		};

		it('una petición de un nodo anterior se acepta, marcada como legado', () => {
			expect(verificar(firmarComoAntes())).toEqual({ ok: true, legado: true });
		});

		it('y tampoco vale dos veces', () => {
			const c = firmarComoAntes();
			const vistas = new Map();
			expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: true, legado: true });
			expect(verificar(c, '{"v":1}', vistas)).toEqual({ ok: false, motivo: 'repeated request' });
		});

		it('la petición de un nodo nuevo la entiende un panel anterior (su x-firma es la de siempre)', () => {
			const c = firmar();
			/* Lo único que miraba el panel anterior: la firma vieja sobre la cadena vieja. */
			expect(
				verificar({ 'x-nodo': c['x-nodo'], 'x-fecha': c['x-fecha'], 'x-firma': c['x-firma'] })
			).toEqual({
				ok: true,
				legado: true
			});
		});
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
		/* Una fecha que no se lee no vale para siempre. */
		const raro = firmarEstado(panel.privada, estado({ caduca: 'nunca' }));
		expect(verificarEstado(panel.publica, 'aldanza', raro)).toMatchObject({ ok: false });
	});

	/* Auditoría 2026-11-14, «canal firmado»: `tipo` dentro de lo firmado y `emitido` creciente. */
	describe('tipo y emitido', () => {
		const ahora = Date.parse('2026-11-17T12:00:00Z');
		const en = (ms: number) => new Date(ahora + ms).toISOString();
		const tipado = (emitido: number, cambios: Partial<EstadoDeseado> = {}) =>
			firmarEstado(
				panel.privada,
				estado({ tipo: 'estado', emitido: en(emitido), caduca: en(emitido + 3600_000), ...cambios })
			);
		const verificar = (f: ReturnType<typeof firmarEstado>, ultimoEmitido?: string | null) =>
			verificarEstado(panel.publica, 'aldanza', f, ahora, { ultimoEmitido });

		it('un estado tipado se acepta y no es legado', () => {
			expect(verificar(tipado(0))).toMatchObject({ ok: true, legado: false });
		});

		it('con otro tipo no vale (una lista global o de Tor firmadas por el panel tampoco)', () => {
			for (const tipo of ['global', 'tor', 'Estado'])
				expect(verificar(tipado(0, { tipo } as unknown as Partial<EstadoDeseado>)), tipo).toEqual({
					ok: false,
					motivo: 'not a desired state'
				});
		});

		it('cambiar el tipo por el camino rompe la firma', () => {
			const f = tipado(0);
			const tocado = { ...f, estado: f.estado.replace('"tipo":"estado"', '"tipo":"global"') };
			expect(verificar(tocado)).toEqual({ ok: false, motivo: 'invalid Central signature' });
		});

		it('repetir un estado anterior al último aceptado no vale', () => {
			const viejo = tipado(-20 * 60_000, { modulos: ['cowrie', 'rdp'] });
			const nuevo = tipado(-60_000, { modulos: ['cowrie'] });
			const v = verificar(nuevo);
			expect(v).toMatchObject({ ok: true });
			const ultimo = ultimoEmitidoTras(null, v as Extract<typeof v, { ok: true }>);
			expect(ultimo).toBe(en(-60_000));
			expect(verificar(viejo, ultimo)).toEqual({
				ok: false,
				motivo: 'the state is older than the last one accepted'
			});
		});

		it('el mismo estado otra vez sí vale: el panel reutiliza la firma hasta media hora', () => {
			const f = tipado(-60_000);
			expect(verificar(f, en(-60_000))).toMatchObject({ ok: true });
		});

		it('un emitido que no se lee, o disparado hacia el futuro, no vale', () => {
			expect(verificar(tipado(0, { emitido: 'ayer' }))).toEqual({
				ok: false,
				motivo: 'the state has an invalid issue date'
			});
			expect(verificar(tipado(2 * 86_400_000))).toEqual({
				ok: false,
				motivo: 'the state has an invalid issue date'
			});
		});

		it('ultimoEmitidoTras solo avanza, y solo con estados tipados', () => {
			const v = (f: ReturnType<typeof firmarEstado>) =>
				verificar(f) as Extract<ReturnType<typeof verificar>, { ok: true }>;
			expect(ultimoEmitidoTras(en(0), v(tipado(-60_000)))).toBe(en(0));
			expect(ultimoEmitidoTras(en(-60_000), v(tipado(0)))).toBe(en(0));
			const sinTipo = firmarEstado(panel.privada, estado({ emitido: en(0), caduca: en(3600_000) }));
			expect(ultimoEmitidoTras(en(-60_000), v(sinTipo))).toBe(en(-60_000));
			expect(ultimoEmitidoTras('roto', v(tipado(0)))).toBe(en(0));
		});

		/* Compatibilidad: así firma el estado un panel hasta la 0.31 (sin `tipo`). */
		describe('compatibilidad con los paneles anteriores', () => {
			const sinTipo = (emitido: number) =>
				firmarEstado(
					panel.privada,
					estado({ emitido: en(emitido), caduca: en(emitido + 3600_000) })
				);

			it('un estado sin tipo se acepta, marcado como legado', () => {
				expect(verificar(sinTipo(0))).toMatchObject({ ok: true, legado: true });
			});

			it('el panel anterior puede repetir uno más viejo (reutiliza firmas) y se acepta', () => {
				expect(verificar(sinTipo(-20 * 60_000))).toMatchObject({ ok: true, legado: true });
			});

			it('pero no uno anterior al último tipado aceptado (no sirve para saltarse la regla)', () => {
				expect(verificar(sinTipo(-20 * 60_000), en(-60_000))).toEqual({
					ok: false,
					motivo: 'the state is older than the last one accepted'
				});
			});

			it('un nodo anterior entiende el estado tipado: `tipo` es un campo más', () => {
				/* verificarEstado de la 0.31 (c7d228d6), tal cual: firma, versión, cliente y caducidad. */
				const comoAntes = (f: ReturnType<typeof firmarEstado>) => {
					if (!firmadoPorPanel(panel.publica, f.estado, f.firma, f.firmas)) return false;
					const e = JSON.parse(f.estado) as EstadoDeseado;
					if (e.version !== 1 || e.cliente !== 'aldanza') return false;
					const caduca = Date.parse(e.caduca);
					return Number.isFinite(caduca) && caduca >= ahora;
				};
				expect(comoAntes(tipado(0))).toBe(true);
			});
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

	it('«urgente» va firmado y tiene que ser booleano (como en Go)', () => {
		const ok = verificarRelease(
			publicacion.publica,
			firmarRelease(publicacion.privada, { ...release, urgente: true })
		);
		expect(ok.ok && ok.release.urgente).toBe(true);
		const mal = { ...release, urgente: 'si' } as unknown as typeof release;
		expect(
			verificarRelease(publicacion.publica, firmarRelease(publicacion.privada, mal))
		).toMatchObject({ ok: false, motivo: 'malformed urgent flag' });
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
	it('Community: todas de ghcr.io; mezcladas, de ninguna (A3 de la revisión)', () => {
		expect(
			edicionDeRelease(
				r(
					{ consola: 'ghcr.io/seguridadsi/sugardaddy-consola@sha256:1' },
					'ghcr.io/seguridadsi/sugardaddy-actualizador@sha256:2'
				)
			)
		).toBe('community');
		expect(
			edicionDeRelease(
				r(
					{ consola: 'ghcr.io/seguridadsi/sugardaddy-consola@sha256:1' },
					'ejemplo.azurecr.io/sugardaddy-actualizador@sha256:2'
				)
			)
		).toBe(null);
	});
	it('desarrollo o vacía: ni una ni otra', () => {
		expect(edicionDeRelease(r({ consola: 'localhost:5000/sugardaddy-consola@sha256:1' }))).toBe(
			null
		);
		expect(edicionDeRelease(r({}))).toBe(null);
	});
});
