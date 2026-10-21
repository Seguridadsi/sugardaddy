/*
 * La colocación de las trampas (docs/diseno/modulo-despliegue.md §8, paso
 * 10), sin base de datos: una prueba por cada fila de la tabla de §8.1 y el
 * estado visible de §8.2. Las mismas transiciones, aplicadas por plan(),
 * informarEstado y recibirEventos, se prueban contra una base de datos de
 * verdad en colocacion-base.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Capacidades, Colocacion, Honeycosa } from '@sugardaddy/contrato';

/* Sin base de datos: db no se conecta hasta la primera consulta, y aquí no hay ninguna. */
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/environment', () => ({ building: true, dev: true }));

const { leerHoneycosa } = await import('@sugardaddy/contrato');
const { schema: s } = await import('./db');
const c = await import('./colocacion');
type Fila = import('./colocacion').FilaColocacion;
type Trampa = import('./colocacion').TrampaColocada;
type Contexto = import('./colocacion').ContextoVisible;

const AHORA = new Date('2026-10-17T10:00:00Z');
const ANTES = new Date('2026-10-16T09:00:00Z');

const fila = (colocacion: Colocacion, x: Partial<Fila> = {}): Fila => ({
	colocacion,
	colocacionMotivo: null,
	comprobada: null,
	activo: true,
	donde: '0.0.0.0:2222',
	...x
});
const limpio = { id: 't', donde: '0.0.0.0:2222' };

describe('transiciones de §8.1: una prueba por fila', () => {
	it('alta: nace por colocar', () => {
		expect(s.trampas.colocacion.default).toBe('por-colocar');
	});

	it.each(['colocada', 'comprobada', 'degradada'] as const)(
		'plan() la deja fuera desde %s: por colocar con el código del descarte',
		(desde) => {
			expect(
				c.trasDescarte(
					fila(desde, { colocacionMotivo: desde === 'degradada' ? 'despliegue.error' : null }),
					'carga.sin-credencial',
					AHORA
				)
			).toEqual({
				colocacion: 'por-colocar',
				colocacionMotivo: 'carga.sin-credencial',
				colocacionCuando: AHORA
			});
		}
	);

	it('plan() la deja fuera estando por colocar: solo cambia el código, si cambió', () => {
		const f = fila('por-colocar', { colocacionMotivo: 'carga.sin-credencial' });
		expect(c.trasDescarte(f, 'carga.sin-credencial', AHORA)).toEqual({});
		expect(c.trasDescarte(f, 'modulo.no-autorizado', AHORA)).toEqual({
			colocacionMotivo: 'modulo.no-autorizado',
			colocacionCuando: AHORA
		});
	});

	it.each([
		['por-colocar', null, 'colocada'],
		['por-colocar', ANTES, 'comprobada'],
		['degradada', null, 'colocada'],
		['degradada', ANTES, 'comprobada']
	] as const)(
		'estado limpio desde %s (comprobada: %s): %s y sin motivo',
		(desde, comprobada, hacia) => {
			const f = fila(desde, { comprobada, colocacionMotivo: 'despliegue.error' });
			expect(c.trasEstado(f, limpio, AHORA)).toEqual({
				colocacion: hacia,
				colocacionMotivo: null,
				colocacionCuando: AHORA
			});
		}
	);

	it('estado limpio de una ya puesta: quita el código de un descarte de antes, y si no hay nada, no escribe', () => {
		expect(
			c.trasEstado(
				fila('comprobada', { colocacionMotivo: 'carga.sin-credencial', comprobada: ANTES }),
				limpio,
				AHORA
			)
		).toEqual({ colocacionMotivo: null, colocacionCuando: AHORA });
		expect(c.trasEstado(fila('colocada'), limpio, AHORA)).toEqual({});
		expect(c.trasEstado(fila('comprobada', { comprobada: ANTES }), limpio, AHORA)).toEqual({});
	});

	it.each(['colocada', 'comprobada', 'degradada'] as const)(
		'estado con error desde %s: degradada con el código del sensor o despliegue.error',
		(desde) => {
			const f = fila(desde);
			const r = c.trasEstado(
				f,
				{ id: 't', donde: 'error: motor.permiso: sin permiso', codigo: 'motor.permiso' },
				AHORA
			);
			expect({ ...f, ...r }.colocacion).toBe('degradada');
			expect(
				c.trasEstado(f, { id: 't', donde: 'error: puerto ocupado' }, AHORA).colocacionMotivo
			).toBe('despliegue.error');
			expect(
				c.trasEstado(
					f,
					{ id: 't', donde: 'error: motor.permiso: sin permiso', codigo: 'motor.permiso' },
					AHORA
				).colocacionMotivo
			).toBe('motor.permiso');
		}
	);

	it('estado con error estando por colocar: sigue por colocar, con el código', () => {
		expect(
			c.trasEstado(
				fila('por-colocar', { donde: 'desplegando…' }),
				{ id: 't', donde: 'error: descargando la imagen nueva' },
				AHORA
			)
		).toEqual({ colocacionMotivo: 'despliegue.error', colocacionCuando: AHORA });
	});

	it('«parada: …» (la ha parado el propio sensor) cuenta como error: despliegue.parada', () => {
		const e = { id: 't', donde: 'parada: cuota superada (registros.sin-perforar)' };
		expect(c.trasEstado(fila('comprobada', { comprobada: ANTES }), e, AHORA)).toEqual({
			colocacion: 'degradada',
			colocacionMotivo: 'despliegue.parada',
			colocacionCuando: AHORA
		});
		/* Un aviso que lleva la palabra no es una parada. */
		expect(c.paradaPorSensor('0.0.0.0:80 · aviso: parada: no')).toBe(false);
	});

	it.each(['por-colocar', 'colocada', 'comprobada', 'degradada'] as const)(
		'estado sin error con un aviso que degrada (aislamiento.se-ven) desde %s: degradada',
		(desde) => {
			const r = c.trasEstado(
				fila(desde),
				{ ...limpio, avisos: ['aislamiento.sin-garantia', 'aislamiento.se-ven'] },
				AHORA
			);
			expect({ ...fila(desde), ...r }).toMatchObject({
				colocacion: 'degradada',
				colocacionMotivo: 'aislamiento.se-ven'
			});
		}
	);

	it('los demás avisos no cambian la colocación', () => {
		for (const aviso of [
			'aislamiento.sin-garantia',
			'imagen.descargando',
			'imagen.descarga-fallida',
			'red.no-preparada'
		])
			expect(c.trasEstado(fila('colocada'), { ...limpio, avisos: [aviso] }, AHORA)).toEqual({});
	});

	it('primer evento real de una puesta, o por colocar en camino: comprobada', () => {
		for (const f of [
			fila('colocada'),
			fila('por-colocar', { donde: 'desplegando…' }),
			fila('por-colocar', { donde: 'pasos a mano' })
		])
			expect(c.trasEvento(f, AHORA)).toEqual({
				comprobada: AHORA,
				colocacion: 'comprobada',
				colocacionCuando: AHORA
			});
	});

	it('primer evento real de una por colocar con un fallo o una parada de su sensor (llega de la cola): sigue por colocar', () => {
		for (const f of [
			fila('por-colocar', {
				colocacionMotivo: 'despliegue.parada',
				donde: 'parada: sus registros iban a llenar el disco'
			}),
			fila('por-colocar', {
				colocacionMotivo: 'despliegue.error',
				donde: 'error: no se pudo descargar la imagen nueva (EOF); se reintenta'
			}),
			fila('por-colocar', {
				colocacionMotivo: 'motor.permiso',
				donde: 'error: motor.permiso: sin permiso'
			}),
			/* Como las dejan la 0012 y completarDestinos: el motivo nulo y el fallo en «donde». */
			fila('por-colocar', { donde: 'parada: sus registros iban a llenar el disco' }),
			fila('por-colocar', { donde: 'error: el contenedor no arranca' }),
			fila('por-colocar', { donde: 'en espera: el módulo cowrie no está autorizado' })
		])
			expect(c.trasEvento(f, AHORA), f.donde).toEqual({ comprobada: AHORA });
		/* El primer estado limpio la deja comprobada. */
		const f = fila('por-colocar', { colocacionMotivo: 'despliegue.parada', donde: 'parada: x' });
		const tras = { ...f, ...c.trasEvento(f, AHORA) };
		expect(c.trasEstado(tras, limpio, AHORA)).toMatchObject({
			colocacion: 'comprobada',
			colocacionMotivo: null
		});
	});

	it('primer evento real de una por colocar con descarte del plan (llega de la cola): sigue por colocar', () => {
		const f = fila('por-colocar', {
			colocacionMotivo: 'modulo.no-autorizado',
			donde: 'en espera: el módulo cowrie no está autorizado'
		});
		expect(c.trasEvento(f, AHORA)).toEqual({ comprobada: AHORA });
		/* Una parada desde la consola, igual: el evento venía de su cola. */
		expect(c.trasEvento(fila('por-colocar', { activo: false }), AHORA)).toEqual({
			comprobada: AHORA
		});
	});

	it('primer evento real de una degradada: sigue degradada, pero se fija comprobada', () => {
		expect(c.trasEvento(fila('degradada'), AHORA)).toEqual({ comprobada: AHORA });
	});

	it('solo el primero: con comprobada ya fijada, un evento no cambia nada', () => {
		expect(c.trasEvento(fila('comprobada', { comprobada: ANTES }), AHORA)).toEqual({});
	});

	it('«Ya está hecho» (manual@1): de por colocar a puesta', () => {
		expect(c.trasHecho(fila('por-colocar'), AHORA)).toEqual({
			colocacion: 'colocada',
			colocacionCuando: AHORA
		});
		expect(c.trasHecho(fila('colocada'), AHORA)).toBeNull();
	});

	it.each(['colocada', 'comprobada', 'degradada', 'por-colocar'] as const)(
		'«Parar» desde %s: por colocar y sin motivo',
		(desde) => {
			const f = fila(desde, {
				colocacionMotivo: desde === 'degradada' ? 'despliegue.error' : null
			});
			expect({ ...f, ...c.trasParar(f, AHORA) }).toMatchObject({
				colocacion: 'por-colocar',
				colocacionMotivo: null
			});
		}
	);

	it('«Retirar» con retirada automática (contenedor@1): la fila se borra', () => {
		expect(c.trasRetirar(fila('comprobada'), 'automatica', AHORA)).toBe('borrar');
	});

	it('«Retirar» con retirada confirmada (manual@1): retirando, salvo si ya lo está', () => {
		expect(c.trasRetirar(fila('colocada'), 'confirmada', AHORA)).toEqual({
			colocacion: 'retirando',
			colocacionMotivo: 'retirada.pendiente',
			colocacionCuando: AHORA
		});
		expect(
			c.trasRetirar(
				fila('retirando', { colocacionMotivo: 'retirada.pendiente' }),
				'confirmada',
				AHORA
			)
		).toEqual({});
	});

	it('«Ya lo he quitado»: desde retirando se borra la fila; desde otra, nada', () => {
		expect(c.trasQuitado(fila('retirando'))).toBe('borrar');
		expect(c.trasQuitado(fila('colocada'))).toBeNull();
	});
});

describe('lo que llega tarde o no le toca no mueve nada', () => {
	it('un estado de una trampa fuera del plan o parada (el sensor aún no tenía el plan nuevo)', () => {
		const espera = fila('por-colocar', {
			colocacionMotivo: 'carga.sin-credencial',
			donde: 'en espera: este sensor aún no tiene la credencial del registro'
		});
		expect(c.trasEstado(espera, limpio, AHORA)).toEqual({});
		expect(c.trasEstado(fila('por-colocar', { activo: false }), limpio, AHORA)).toEqual({});
	});

	it('una que vuelve al plan («desplegando…» con el código de antes) sí se pone con su estado limpio', () => {
		const f = fila('por-colocar', {
			colocacionMotivo: 'carga.sin-credencial',
			donde: 'desplegando…',
			comprobada: ANTES
		});
		expect(c.trasEstado(f, limpio, AHORA)).toMatchObject({
			colocacion: 'comprobada',
			colocacionMotivo: null
		});
	});

	it('una que se está retirando: ni el plan, ni su sensor, ni un evento la cambian', () => {
		const f = fila('retirando', { colocacionMotivo: 'retirada.pendiente', comprobada: ANTES });
		expect(c.trasDescarte(f, 'modulo.no-autorizado', AHORA)).toEqual({});
		expect(c.trasEstado(f, { id: 't', donde: 'error: x' }, AHORA)).toEqual({});
		expect(c.trasEvento(f, AHORA)).toEqual({});
	});

	it('cada estado cae en una sola fila: repetirlo no cambia nada (sin vaivenes)', () => {
		const estados = [
			limpio,
			{ id: 't', donde: 'error: x' },
			{ id: 't', donde: 'error: motor.api: x', codigo: 'motor.api' },
			{ ...limpio, avisos: ['aislamiento.se-ven'] },
			{ id: 't', donde: 'parada: cuota' }
		];
		for (const desde of ['por-colocar', 'colocada', 'comprobada', 'degradada'] as const)
			for (const e of estados) {
				const f = fila(desde);
				const una = { ...f, ...c.trasEstado(f, e, AHORA) };
				expect(c.trasEstado(una, e, AHORA)).toEqual({});
			}
	});
});

/* ------------------------------------------------------------------------- */

const yaml = (ruta: string) => readFileSync(ruta, 'utf8');
function honeycosa(ruta: string): Honeycosa {
	const r = leerHoneycosa(yaml(ruta));
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
}
const cowrie = honeycosa('../../modulos/trampas/cowrie/trampa.yaml');
const credencial = honeycosa('../../paquetes/contrato/src/ejemplos/credencial-ssh.v2.yaml');

const trampa = (x: Partial<Trampa> & Pick<Trampa, 'id'>): Trampa => ({
	nombre: x.id,
	modulo: 'cowrie',
	sensor: 's1',
	ejecutor: 'contenedor@1',
	via: 'contenedor',
	parametros: {},
	senalTrampa: null,
	variables: null,
	conMarca: false,
	...fila('comprobada', { comprobada: ANTES }),
	...x
});

/* Una Cowrie comprobada en 10.30.0.5 y una credencial en un Windows que apunta a ella. */
const ssh = trampa({ id: 'ssh', nombre: 'Cowrie de cow', parametros: { puertoSsh: 2222 } });
const cred = trampa({
	id: 'cred',
	nombre: 'Credencial de fs01',
	modulo: 'credencial-ssh',
	ejecutor: 'manual@1',
	via: 'windows',
	donde: '-',
	parametros: { objetivo: 'ssh', usuario: 'svc_sql4k7', sesion: 'nas42' },
	senalTrampa: 'ssh',
	variables: {
		objetivo_direccion: '10.30.0.5',
		objetivo_puertoSsh: '2222',
		sesion: 'nas42',
		usuario: 'svc_sql4k7'
	},
	conMarca: true
});

function contexto(
	x: {
		trampas?: Trampa[];
		latido?: Date | null;
		capacidades?: Capacidades | null;
		direccion?: string;
	} = {}
): Contexto {
	const ts = x.trampas ?? [ssh, cred];
	return {
		ahora: AHORA.getTime(),
		sensores: new Map([
			[
				's1',
				{
					ultimoLatido: x.latido === undefined ? new Date(AHORA.getTime() - 30_000) : x.latido,
					capacidades: x.capacidades ?? null
				}
			]
		]),
		trampas: new Map(ts.map((t) => [t.id, t])),
		direcciones: new Map([['ssh', x.direccion ?? '10.30.0.5']]),
		honeycosas: new Map([
			['cowrie', cowrie],
			['credencial-ssh', credencial]
		])
	};
}
const motor = (m: Capacidades['motor'], hechos: Capacidades['hechos'] = {}): Capacidades => ({
	motor: m,
	hechos
});

describe('estado visible (§8.2)', () => {
	it('comprobada es lo único activo; puesta sin evento, no', () => {
		const e = c.estadoVisible(ssh, contexto());
		expect(e).toMatchObject({ estado: 'comprobada', etiqueta: 'Comprobada', activa: true });
		const sin = c.estadoVisible(trampa({ id: 'x', ...fila('colocada') }), contexto());
		expect(sin).toMatchObject({ estado: 'colocada', etiqueta: 'Puesta, sin comprobar' });
		expect(sin.activa).toBe(false);
	});

	it('retirando y parada van antes que todo', () => {
		expect(
			c.estadoVisible(trampa({ id: 'x', colocacion: 'retirando' }), contexto({ latido: null }))
		).toMatchObject({ estado: 'retirando', codigo: 'retirada.pendiente', activa: false });
		expect(
			c.estadoVisible(trampa({ id: 'x', activo: false }), contexto({ latido: null }))
		).toMatchObject({ estado: 'parada', etiqueta: 'Parada', activa: false });
	});

	it('un sensor sin latido: sin contacto, aunque lo guardado diga comprobada', () => {
		const viejo = new Date(AHORA.getTime() - 6 * 60_000);
		expect(c.estadoVisible(ssh, contexto({ latido: viejo }))).toMatchObject({
			estado: 'sin-contacto',
			etiqueta: 'Sin contacto',
			activa: false
		});
		expect(c.estadoVisible(ssh, contexto({ latido: null })).estado).toBe('sin-contacto');
	});

	it('por su máquina: un fallo del motor degrada con su código', () => {
		const e = c.estadoVisible(
			ssh,
			contexto({
				capacidades: motor({ codigo: 'motor.inalcanzable', error: 'no llega al motor' })
			})
		);
		expect(e).toMatchObject({
			estado: 'degradada',
			codigo: 'motor.inalcanzable',
			motivo: 'El sensor no llega a su motor de contenedores',
			activa: false
		});
	});

	it('por su máquina: la IP del motor (origen.pasarela, desktop, wsl) degrada con red.ip-oculta', () => {
		for (const motivo of ['origen.pasarela', 'origen.desktop', 'origen.wsl'])
			expect(
				c.estadoVisible(
					ssh,
					contexto({
						capacidades: motor(
							{ tipo: 'docker', modo: 'rootful' },
							{ 'red.ipOrigenReal': { valor: false, motivo } }
						)
					})
				)
			).toMatchObject({ estado: 'degradada', codigo: 'red.ip-oculta' });
	});

	it('por su máquina: sin root (origen.rootless) o sin garantía, solo un aviso', () => {
		const e = c.estadoVisible(
			ssh,
			contexto({
				capacidades: motor(
					{ tipo: 'docker', modo: 'rootful', sinGarantia: true, api: '1.48' },
					{ 'red.ipOrigenReal': { valor: false, motivo: 'origen.rootless' } }
				)
			})
		);
		expect(e).toMatchObject({ estado: 'comprobada', activa: true });
		expect(e.avisos.map((a) => a.codigo)).toEqual(['origen.rootless', 'motor.sin-garantia']);
	});

	it('por su máquina solo si está puesta: una por colocar lo lleva como aviso', () => {
		const e = c.estadoVisible(
			trampa({ id: 'x', ...fila('por-colocar', { donde: 'desplegando…' }) }),
			contexto({ capacidades: motor({ codigo: 'motor.permiso' }) })
		);
		expect(e).toMatchObject({ estado: 'por-colocar', motivo: 'Su sensor la está poniendo.' });
		expect(e.avisos.map((a) => a.codigo)).toEqual(['motor.permiso']);
	});

	it('lo guardado: degradada con el detalle de su sensor', () => {
		const e = c.estadoVisible(
			trampa({
				id: 'x',
				...fila('degradada', {
					colocacionMotivo: 'motor.permiso',
					donde: 'error: motor.permiso: el sensor no tiene permiso para usar el motor'
				})
			}),
			contexto()
		);
		expect(e).toMatchObject({
			estado: 'degradada',
			codigo: 'motor.permiso',
			motivo: 'Su sensor no la tiene en marcha.',
			detalle: 'El sensor no tiene permiso para usar el motor.'
		});
		const parada = c.estadoVisible(
			trampa({
				id: 'x',
				...fila('degradada', { colocacionMotivo: 'despliegue.parada', donde: 'parada: cuota' })
			}),
			contexto()
		);
		expect(parada).toMatchObject({ motivo: 'El sensor la ha parado.', detalle: 'Cuota.' });
		expect(
			c.estadoVisible(
				trampa({ id: 'x', ...fila('degradada', { colocacionMotivo: 'aislamiento.se-ven' }) }),
				contexto()
			).motivo
		).toMatch(/se ven entre sí/);
	});

	it('lo guardado: por colocar fuera del plan dice lo mismo que el plan', () => {
		const e = c.estadoVisible(
			trampa({
				id: 'x',
				...fila('por-colocar', {
					colocacionMotivo: 'modulo.no-autorizado',
					donde: 'en espera: el módulo cowrie no está autorizado'
				})
			}),
			contexto()
		);
		expect(e).toMatchObject({
			estado: 'por-colocar',
			etiqueta: 'Pendiente de poner',
			codigo: 'modulo.no-autorizado',
			motivo: 'El módulo cowrie no está autorizado.'
		});
		/* De vuelta en el plan: su sensor la está poniendo, ya sin el motivo de antes. */
		expect(
			c.estadoVisible(
				trampa({
					id: 'x',
					...fila('por-colocar', {
						colocacionMotivo: 'modulo.no-autorizado',
						donde: 'desplegando…'
					})
				}),
				contexto()
			)
		).toMatchObject({ codigo: null, motivo: 'Su sensor la está poniendo.' });
	});

	it('lo guardado: por colocar mientras su sensor baja la imagen no es un fallo', () => {
		const por = (donde: string) =>
			c.estadoVisible(
				trampa({
					id: 'x',
					...fila('por-colocar', { colocacionMotivo: 'despliegue.error', donde })
				}),
				contexto()
			);
		expect(por('error: descargando la imagen nueva')).toMatchObject({
			estado: 'por-colocar',
			codigo: 'despliegue.error',
			motivo: 'Su sensor la está poniendo: está descargando su imagen.',
			detalle: null
		});
		/* Si la descarga falla, sí: con lo que dice el sensor. */
		expect(por('error: no se pudo descargar la imagen nueva (EOF); se reintenta')).toMatchObject({
			motivo: 'Su sensor no la tiene en marcha.',
			detalle: 'No se pudo descargar la imagen nueva (EOF); se reintenta.'
		});
	});

	describe('señal por otra trampa', () => {
		it('con su objetivo comprobado: comprobada', () => {
			expect(c.estadoVisible(cred, contexto())).toMatchObject({
				estado: 'comprobada',
				activa: true
			});
		});

		it('sin objetivo (senal_trampa nulo): degradada, senal.objetivo-retirado', () => {
			expect(
				c.estadoVisible({ ...cred, senalTrampa: null }, contexto({ trampas: [cred] }))
			).toMatchObject({ estado: 'degradada', codigo: 'senal.objetivo-retirado' });
		});

		it.each([
			['fuera del plan', { colocacion: 'por-colocar', colocacionMotivo: 'modulo.no-autorizado' }],
			['parada', { activo: false, colocacion: 'por-colocar' }],
			['retirando', { colocacion: 'retirando' }],
			['con un fallo de su sensor', { colocacion: 'degradada', colocacionMotivo: 'motor.api' }]
		] as const)('con el objetivo %s: degradada, senal.objetivo-parado', (_, cambio) => {
			const e = c.estadoVisible(cred, contexto({ trampas: [{ ...ssh, ...cambio }, cred] }));
			expect(e).toMatchObject({ estado: 'degradada', codigo: 'senal.objetivo-parado' });
			expect(e.motivo).toMatch(/^Cowrie de cow no está recibiendo \(/);
		});

		it('si su sensor (el del objetivo) no late: degradada, porque el objetivo está sin contacto', () => {
			const e = c.estadoVisible(
				cred,
				contexto({ latido: new Date(AHORA.getTime() - 10 * 60_000) })
			);
			expect(e).toMatchObject({
				estado: 'degradada',
				codigo: 'senal.objetivo-parado',
				motivo:
					'Cowrie de cow no está recibiendo (sin contacto); mientras tanto, esta credencial no avisa de nada.'
			});
		});

		it('un objetivo degradado por la IP del motor o porque se ven sigue recibiendo', () => {
			const capacidades = motor(
				{ tipo: 'docker', modo: 'rootful' },
				{ 'red.ipOrigenReal': { valor: false, motivo: 'origen.pasarela' } }
			);
			expect(c.estadoVisible(ssh, contexto({ capacidades })).codigo).toBe('red.ip-oculta');
			expect(c.estadoVisible(cred, contexto({ capacidades })).estado).toBe('comprobada');
			const seVen = {
				...ssh,
				colocacion: 'degradada' as const,
				colocacionMotivo: 'aislamiento.se-ven'
			};
			expect(c.estadoVisible(cred, contexto({ trampas: [seVen, cred] })).estado).toBe('comprobada');
		});

		it('si cambia el puerto del objetivo o la dirección de su destino: senal.objetivo-cambiado', () => {
			const puerto = c.estadoVisible(
				cred,
				contexto({ trampas: [{ ...ssh, parametros: { puertoSsh: 2200 } }, cred] })
			);
			expect(puerto).toMatchObject({
				estado: 'degradada',
				codigo: 'senal.objetivo-cambiado',
				motivo:
					'Cowrie de cow ha cambiado (Puerto SSH); lo sembrado apunta a lo de antes. Retírala y vuelve a ponerla.'
			});
			const direccion = c.estadoVisible(cred, contexto({ direccion: '10.30.0.6' }));
			expect(direccion.motivo).toMatch(/\(la dirección de su destino\)/);
			/* Un parámetro que no usan sus pasos (el nombre del equipo) no cuenta. */
			expect(
				c.estadoVisible(
					cred,
					contexto({
						trampas: [{ ...ssh, parametros: { puertoSsh: 2222, nombreEquipo: 'otro' } }, cred]
					})
				).estado
			).toBe('comprobada');
			/* Con el valor por defecto del módulo: 2222 sin escribir sigue siendo 2222. */
			expect(
				c.estadoVisible(cred, contexto({ trampas: [{ ...ssh, parametros: {} }, cred] })).estado
			).toBe('comprobada');
		});

		it('por colocar, el problema de su señal es un aviso', () => {
			const e = c.estadoVisible(
				{ ...cred, colocacion: 'por-colocar', comprobada: null },
				contexto({ trampas: [{ ...ssh, activo: false }] })
			);
			expect(e).toMatchObject({
				estado: 'por-colocar',
				motivo: 'Aún no se ha dicho que esté puesta.'
			});
			expect(e.avisos.map((a) => a.codigo)).toEqual(['senal.objetivo-parado']);
		});
	});
});
