import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CLAVE_HECHO,
	HECHOS,
	NOMBRE_HECHO,
	evaluarRequisito,
	fusionar,
	hechosDeConsola,
	hechosDeFormulario,
	hechosDeSensor,
	leerCapacidades,
	nombreHecho,
	valorVisible,
	type Capacidades,
	type Hechos
} from './index.ts';

/*
 * Hechos de un destino (docs/diseno/modulo-despliegue.md §4, paso 2): las
 * claves, de dónde sale cada una y cómo se juntan.
 */

const CUANDO = '2026-10-17T10:00:00.000Z';

/* El cuerpo de POST /api/sensor/estado de un sensor 0.13.1 (§4.4). */
const cuerpo131 = {
	trampas: [{ id: 'ssh-backup', donde: '0.0.0.0:22' }],
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
		pasarelas: ['172.30.0.1', '172.31.0.1']
	},
	hechos: { 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' } }
};

/* Lo que guarda la consola en sensores.capacidades. */
const guardado = (cuerpo: unknown): Capacidades & { cuando: string } => ({
	...leerCapacidades(cuerpo),
	cuando: CUANDO
});

describe('hechosDeSensor', () => {
	it('aplana el motor de un sensor 0.13.1 y le pone fuente y cuándo', () => {
		const h = hechosDeSensor(guardado(cuerpo131));
		expect(h).toEqual({
			'motor.tipo': { valor: 'docker', fuente: 'sensor', cuando: CUANDO },
			'motor.modo': { valor: 'rootful', fuente: 'sensor', cuando: CUANDO },
			'motor.version': { valor: '27.3.1', fuente: 'sensor', cuando: CUANDO },
			'motor.api': { valor: '1.47', fuente: 'sensor', cuando: CUANDO },
			'motor.apiMotor': { valor: '1.47', fuente: 'sensor', cuando: CUANDO },
			'motor.apiMinima': { valor: '1.24', fuente: 'sensor', cuando: CUANDO },
			'motor.so': { valor: 'linux', fuente: 'sensor', cuando: CUANDO },
			'motor.arquitectura': { valor: 'amd64', fuente: 'sensor', cuando: CUANDO },
			'motor.sistema': { valor: 'Ubuntu 24.04.1 LTS', fuente: 'sensor', cuando: CUANDO },
			'motor.cgroups': { valor: '2', fuente: 'sensor', cuando: CUANDO },
			'motor.almacenamiento': { valor: 'overlay2', fuente: 'sensor', cuando: CUANDO },
			'motor.pasarelas': {
				valor: ['172.30.0.1', '172.31.0.1'],
				fuente: 'sensor',
				cuando: CUANDO
			},
			'plataforma.so': { valor: 'linux', fuente: 'sensor', cuando: CUANDO },
			'red.ipOrigenReal': { valor: true, motivo: 'origen.real', fuente: 'sensor', cuando: CUANDO }
		});
	});

	it.each(['rootful', 'rootless'])('con el motor en %s, plataforma.so sale de motor.so', (modo) => {
		const h = hechosDeSensor(guardado({ motor: { modo, so: 'linux' } }));
		expect(h['plataforma.so']).toEqual({ valor: 'linux', fuente: 'sensor', cuando: CUANDO });
	});

	it.each(['desktop', 'wsl', 'otro-futuro', undefined])(
		'con el motor en %s no da plataforma.so: el motor dice linux aunque la máquina no lo sea',
		(modo) => {
			const h = hechosDeSensor(guardado({ motor: { modo, so: 'linux' } }));
			expect(h).not.toHaveProperty(['plataforma.so']);
			expect(h['motor.so'].valor).toBe('linux');
		}
	);

	it('un fallo del motor da motor.codigo y motor.error, y nada de plataforma', () => {
		const h = hechosDeSensor(
			guardado({ motor: { codigo: 'motor.permiso', error: 'sin permiso' }, hechos: {} })
		);
		expect(h).toEqual({
			'motor.codigo': { valor: 'motor.permiso', fuente: 'sensor', cuando: CUANDO },
			'motor.error': { valor: 'sin permiso', fuente: 'sensor', cuando: CUANDO }
		});
	});

	it('lee las listas de un sensor con la sonda de puertos (pasos 14a y 14b)', () => {
		const h = hechosDeSensor(
			guardado({
				hechos: {
					'agente.ejecutores': { valor: ['contenedor@1'] },
					'puertos.ocupados': { valor: ['tcp/22', 'udp/53'], motivo: 'puertos.sonda' },
					'motor.clone3': { valor: true, motivo: 'clone3.disponible' }
				}
			})
		);
		expect(h['agente.ejecutores']).toEqual({
			valor: ['contenedor@1'],
			fuente: 'sensor',
			cuando: CUANDO
		});
		expect(h['puertos.ocupados'].valor).toEqual(['tcp/22', 'udp/53']);
		expect(h['motor.clone3']).toMatchObject({ valor: true, motivo: 'clone3.disponible' });
	});

	it('lo que manda el sensor como hecho gana a lo que se deduce del motor', () => {
		const h = hechosDeSensor({
			motor: { modo: 'rootful', so: 'linux' },
			hechos: { 'plataforma.so': { valor: 'windows' } }
		});
		expect(h['plataforma.so']).toEqual({ valor: 'windows', fuente: 'sensor' });
	});

	it('un sensor 0.12 deja sensores.capacidades en null y no da nada', () => {
		expect(hechosDeSensor(null)).toEqual({});
		expect(hechosDeSensor(undefined)).toEqual({});
	});

	it('lo guardado que no tiene la forma se descarta sin fallar', () => {
		const raro = {
			motor: { modo: 7, so: ['linux'], memoria: Number.NaN, desconocido: 'x', cpus: 4 },
			hechos: {
				'red.ipOrigenReal': { valor: { a: 1 } },
				'sin-espacio': { valor: true },
				'red.capa2': 'true',
				'red.direcciones': { valor: ['10.0.0.1', 3] },
				'red.bien': { valor: false, motivo: 7 }
			},
			cuando: 5
		} as unknown as Capacidades;
		expect(hechosDeSensor(raro)).toEqual({
			'motor.cpus': { valor: 4, fuente: 'sensor' },
			'red.bien': { valor: false, fuente: 'sensor' }
		});
		expect(hechosDeSensor('nada' as unknown as Capacidades)).toEqual({});
	});

	it('no da las claves que solo sabe la consola o dice el cliente; las que no conoce, sí', () => {
		const h = hechosDeSensor(
			guardado({
				hechos: {
					'puertos.reservados': { valor: [] },
					'canal.rele': { valor: true },
					'registro.privado': { valor: true },
					'agente.version': { valor: '9.9.9' },
					'conexion.graph.estado': { valor: 'activa' },
					'destino.direccion': { valor: '10.0.0.1' },
					'shell.powershell': { valor: '7.4' },
					'red.ipOrigenReal': { valor: true },
					'red.capa2': { valor: true }
				}
			})
		);
		expect(Object.keys(h).sort()).toEqual(['red.capa2', 'red.ipOrigenReal']);
	});

	it('las listas son copias: cambiar el resultado no toca lo guardado', () => {
		const c = guardado(cuerpo131);
		hechosDeSensor(c)['motor.pasarelas'].valor = [];
		(hechosDeSensor(c)['motor.pasarelas'].valor as string[]).push('x');
		expect(c.motor!.pasarelas).toEqual(['172.30.0.1', '172.31.0.1']);
	});
});

describe('hechosDeConsola', () => {
	it('un sensor 0.12: agente.ejecutores por defecto con fuente consola y agente.version', () => {
		expect(hechosDeConsola({ id: 'fs01', versionAgente: '0.12.3', registroPrivado: null })).toEqual(
			{
				'agente.ejecutores': {
					valor: ['contenedor@1'],
					motivo: 'agente.anterior',
					fuente: 'consola'
				},
				'agente.version': { valor: '0.12.3', fuente: 'consola' }
			}
		);
	});

	it('registro.privado solo si el sensor lo ha dicho', () => {
		expect(hechosDeConsola({ id: 'a', registroPrivado: true })['registro.privado']).toEqual({
			valor: true,
			fuente: 'consola'
		});
		expect(hechosDeConsola({ id: 'a', registroPrivado: false })['registro.privado'].valor).toBe(
			false
		);
		expect(hechosDeConsola({ id: 'a' })).not.toHaveProperty(['registro.privado']);
		expect(hechosDeConsola({ id: 'a', versionAgente: '' })).not.toHaveProperty(['agente.version']);
	});

	it('el sensor local tiene reservado el 443 de la consola', () => {
		expect(hechosDeConsola({ id: 'local' })['puertos.reservados']).toEqual({
			valor: ['tcp/443'],
			fuente: 'consola'
		});
		expect(hechosDeConsola({ id: 'remoto' })).not.toHaveProperty(['puertos.reservados']);
	});

	it('un destino sin sensor no tiene hechos de consola', () => {
		expect(hechosDeConsola(null)).toEqual({});
	});
});

describe('hechosDeFormulario', () => {
	it('fs01: un servidor de ficheros Windows con PowerShell 5.1', () => {
		expect(
			hechosDeFormulario({
				so: 'windows',
				edicion: 'servidor',
				version: '10.0.17763',
				powershell: '5.1',
				direccion: '10.20.0.7',
				protocolos: ['smb']
			})
		).toEqual({
			'plataforma.so': { valor: 'windows', fuente: 'formulario' },
			'plataforma.edicion': { valor: 'servidor', fuente: 'formulario' },
			'plataforma.version': { valor: '10.0.17763', fuente: 'formulario' },
			'shell.powershell': { valor: '5.1', fuente: 'formulario' },
			'destino.direccion': { valor: '10.20.0.7', fuente: 'formulario' },
			'fileserver.protocolos': { valor: ['smb'], fuente: 'formulario' }
		});
	});

	it('una máquina Linux con sh', () => {
		expect(hechosDeFormulario({ so: 'linux', posix: 'busybox', version: '3.20' })).toEqual({
			'plataforma.so': { valor: 'linux', fuente: 'formulario' },
			'shell.posix': { valor: 'busybox', fuente: 'formulario' },
			'plataforma.version': { valor: '3.20', fuente: 'formulario' }
		});
	});

	it('lo que no cuadra se descarta, sin recortar', () => {
		expect(
			hechosDeFormulario({
				so: 'Windows 11',
				edicion: ['servidor'],
				version: 10,
				powershell: '   ',
				posix: 'zsh',
				direccion: 'x'.repeat(254),
				protocolos: ['smb', 'afp', 'smb', 3],
				notas: 'texto libre',
				'plataforma.so': 'windows'
			})
		).toEqual({ 'fileserver.protocolos': { valor: ['smb'], fuente: 'formulario' } });
		expect(hechosDeFormulario({ protocolos: 'smb', direccion: ` ${'x'.repeat(253)} ` })).toEqual({
			'destino.direccion': { valor: 'x'.repeat(253), fuente: 'formulario' }
		});
	});

	it('el texto libre de un destino «otro» no es un hecho', () => {
		expect(hechosDeFormulario({ so: 'linux', nota: 'La impresora de la planta 2' })).toEqual({
			'plataforma.so': { valor: 'linux', fuente: 'formulario' }
		});
	});

	it('sin respuestas, o con algo que no es un objeto, no hay hechos', () => {
		for (const d of [{}, null, undefined, 'windows', ['windows'], 7])
			expect(hechosDeFormulario(d)).toEqual({});
		expect(hechosDeFormulario(JSON.parse('{"__proto__": {"so": "windows"}}'))).toEqual({});
		expect(hechosDeFormulario(Object.create({ so: 'windows' }))).toEqual({});
	});
});

describe('fusionar', () => {
	const de = (fuente: 'sensor' | 'consola' | 'formulario' | undefined, valor: string): Hechos => ({
		'plataforma.so': fuente ? { valor, fuente } : { valor }
	});

	it('respeta la precedencia sensor > consola > formulario, en cualquier orden', () => {
		const capas = [de('formulario', 'f'), de('consola', 'c'), de('sensor', 's')];
		const ordenes = [
			[0, 1, 2],
			[0, 2, 1],
			[1, 0, 2],
			[1, 2, 0],
			[2, 0, 1],
			[2, 1, 0]
		];
		for (const o of ordenes)
			expect(fusionar(...o.map((i) => capas[i]))['plataforma.so'].valor).toBe('s');
		expect(fusionar(de('formulario', 'f'), de('consola', 'c'))['plataforma.so'].valor).toBe('c');
		expect(fusionar(de('consola', 'c'), de('formulario', 'f'))['plataforma.so'].valor).toBe('c');
	});

	it('con la misma fuente gana la última capa; sin fuente, pierde con todas', () => {
		expect(fusionar(de('sensor', 'a'), de('sensor', 'b'))['plataforma.so'].valor).toBe('b');
		expect(fusionar(de('formulario', 'f'), de(undefined, 'x'))['plataforma.so'].valor).toBe('f');
		expect(fusionar(de(undefined, 'x'))['plataforma.so'].valor).toBe('x');
	});

	it('junta claves distintas de cada capa', () => {
		expect(
			Object.keys(
				fusionar(
					{ 'shell.powershell': { valor: '5.1', fuente: 'formulario' } },
					{ 'agente.version': { valor: '0.13.1', fuente: 'consola' } },
					{ 'motor.modo': { valor: 'rootful', fuente: 'sensor' } }
				)
			).sort()
		).toEqual(['agente.version', 'motor.modo', 'shell.powershell']);
	});

	it('una clave sin la forma del contrato no pasa, tampoco __proto__', () => {
		const r = fusionar(JSON.parse('{"__proto__": {"valor": 1}, "sin-punto": {"valor": 1}}'));
		expect(r).toEqual({});
		expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
	});

	it('no cambia las capas que recibe', () => {
		const a = Object.freeze(de('formulario', 'f'));
		const b = Object.freeze(de('sensor', 's'));
		expect(() => fusionar(a, b)).not.toThrow();
		expect(a['plataforma.so'].valor).toBe('f');
	});
});

describe('los hechos de un destino, juntos (§4.3)', () => {
	const hechosDe = (descripcion: unknown, capacidades: unknown) =>
		fusionar(
			hechosDeFormulario(descripcion),
			hechosDeConsola({ id: 'fs01', versionAgente: '0.13.1', registroPrivado: true }),
			hechosDeSensor(guardado(capacidades))
		);

	it('con motor.modo = desktop, plataforma.so sale del formulario y no del motor', () => {
		const h = hechosDe({ so: 'windows' }, { motor: { modo: 'desktop', so: 'linux' } });
		expect(h['plataforma.so']).toEqual({ valor: 'windows', fuente: 'formulario' });
	});

	it('con un sensor rootful, plataforma.so sale del sensor aunque el formulario diga otra cosa', () => {
		const h = hechosDe({ so: 'windows', powershell: '5.1' }, cuerpo131);
		expect(h['plataforma.so']).toMatchObject({ valor: 'linux', fuente: 'sensor' });
		/* Lo que el sensor no informa sigue saliendo del formulario. */
		expect(h['shell.powershell']).toEqual({ valor: '5.1', fuente: 'formulario' });
	});

	it('el agente.ejecutores del sensor gana al de por defecto de la consola', () => {
		const sin = hechosDe({}, cuerpo131);
		expect(sin['agente.ejecutores']).toMatchObject({
			fuente: 'consola',
			motivo: 'agente.anterior'
		});
		const con = hechosDe(
			{},
			{ ...cuerpo131, hechos: { 'agente.ejecutores': { valor: ['contenedor@1', 'servicio@1'] } } }
		);
		expect(con['agente.ejecutores']).toEqual({
			valor: ['contenedor@1', 'servicio@1'],
			fuente: 'sensor',
			cuando: CUANDO
		});
	});

	it('un sensor no pisa lo que pone la consola en el sensor local', () => {
		const h = fusionar(
			hechosDeConsola({ id: 'local', registroPrivado: false }),
			hechosDeSensor(
				guardado({
					...cuerpo131,
					hechos: {
						'puertos.reservados': { valor: [] },
						'canal.rele': { valor: true },
						'registro.privado': { valor: true },
						'agente.version': { valor: '9.9.9' }
					}
				})
			)
		);
		expect(h['puertos.reservados']).toEqual({ valor: ['tcp/443'], fuente: 'consola' });
		expect(h['registro.privado']).toEqual({ valor: false, fuente: 'consola' });
		expect(h).not.toHaveProperty(['canal.rele']);
		expect(h).not.toHaveProperty(['agente.version']);
	});

	it('el comparador de requisitos los entiende tal cual', () => {
		const h = hechosDe({ so: 'windows', powershell: '5.1' }, { motor: { modo: 'desktop' } });
		const cumple = (r: object) => evaluarRequisito({ motivo: 'm', ...r } as never, h);
		expect(cumple({ hecho: 'shell.powershell', minimo: '5.1' })).toBe('cumple');
		expect(cumple({ hecho: 'plataforma.so', igual: 'windows' })).toBe('cumple');
		expect(cumple({ hecho: 'motor.modo', en: ['rootful'], siFalta: 'ignora' })).toBe('no-cumple');
		expect(cumple({ hecho: 'agente.ejecutores', contiene: 'contenedor@1' })).toBe('cumple');
		expect(cumple({ hecho: 'agente.version', minimo: '0.13.0' })).toBe('cumple');
		expect(cumple({ hecho: 'registro.privado', igual: true })).toBe('cumple');
		expect(cumple({ hecho: 'motor.codigo', presente: false })).toBe('cumple');
	});
});

describe('catálogo de claves (§4.2)', () => {
	it('cada clave cumple la expresión regular del contrato', () => {
		for (const k of Object.keys(HECHOS)) expect(CLAVE_HECHO.test(k), k).toBe(true);
	});

	it('lo que da cada función está en el catálogo, con esa fuente', () => {
		const motor = Object.fromEntries(
			[
				'tipo',
				'modo',
				'version',
				'api',
				'apiMotor',
				'apiMinima',
				'so',
				'arquitectura',
				'kernel',
				'sistema',
				'cgroups',
				'cgroupDriver',
				'almacenamiento',
				'puertaEnlace'
			].map((k) => [k, k === 'modo' ? 'rootful' : 'x'])
		);
		const todo = {
			...hechosDeSensor(
				guardado({
					motor: {
						...motor,
						sinGarantia: true,
						seguridad: ['name=seccomp'],
						pasarelas: ['172.19.0.1'],
						memoria: 1,
						cpus: 1,
						codigo: 'motor.api',
						error: 'x'
					},
					hechos: {
						'red.ipOrigenReal': { valor: true },
						'motor.clone3': { valor: true },
						'agente.ejecutores': { valor: [] },
						'agente.plataforma': { valor: 'linux-amd64' },
						'puertos.ocupados': { valor: [] },
						'red.direcciones': { valor: [] }
					}
				})
			),
			...hechosDeConsola({ id: 'local', versionAgente: '0.13.1', registroPrivado: true }),
			...hechosDeFormulario({
				so: 'nas',
				edicion: 'puesto',
				version: '1',
				powershell: '7.4',
				posix: 'sh',
				direccion: 'nas01',
				protocolos: ['nfs']
			})
		};
		expect(Object.keys(todo).length).toBeGreaterThan(35);
		for (const [k, h] of Object.entries(todo)) {
			expect(HECHOS, k).toHaveProperty([k]);
			expect(HECHOS[k].fuentes, k).toContain(h.fuente);
		}
		/* Los del motor, todos los campos de MotorSensor. */
		for (const campo of [...Object.keys(motor), 'sinGarantia', 'seguridad', 'pasarelas'])
			expect(todo, campo).toHaveProperty([`motor.${campo}`]);
	});
});

describe('nombres para el cliente', () => {
	/* Los motivos del elector y la ficha de un destino no enseñan claves (§7.4). */
	it('cada hecho con nombre está en el catálogo, y uno sin nombre se enseña con su clave', () => {
		for (const k of Object.keys(NOMBRE_HECHO)) expect(HECHOS, k).toHaveProperty([k]);
		expect(nombreHecho('plataforma.so')).toBe('Sistema operativo');
		expect(nombreHecho('canal.panel')).toBe('canal.panel');
		expect(nombreHecho('__proto__')).toBe('__proto__');
	});

	it('los valores con nombre salen con él; el resto, como texto', () => {
		expect(valorVisible('plataforma.so', 'windows')).toBe('Windows');
		expect(valorVisible('plataforma.edicion', 'puesto')).toBe('Puesto de trabajo');
		expect(valorVisible('motor.modo', 'desktop')).toBe('Docker Desktop');
		expect(valorVisible('plataforma.so', 'beos')).toBe('beos');
		expect(valorVisible('red.ipOrigenReal', false)).toBe('no');
		expect(valorVisible('puertos.ocupados', ['tcp/22', 'udp/53'])).toBe('tcp/22, udp/53');
		expect(valorVisible('puertos.ocupados', [])).toBe('ninguno');
		expect(valorVisible('motor.memoria', 2048)).toBe('2048');
	});
});

describe('un solo Hecho en el contrato', () => {
	/*
	 * index.ts lo reexporta todo con «export *»: un segundo Hecho (o Hechos,
	 * ValorHecho) en otro fichero chocaría (TS2308) y la consola dejaría de
	 * compilar (§4.1). Vive en capacidades.ts, el de la 0.13.1.
	 */
	it('Hecho, Hechos y ValorHecho se declaran solo en capacidades.ts', () => {
		const dir = new URL('.', import.meta.url);
		for (const nombre of ['Hecho', 'Hechos', 'ValorHecho']) {
			const declara = new RegExp(`^export (interface|type) ${nombre}\\b`, 'm');
			const ficheros = readdirSync(dir)
				.filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
				.filter((f) => declara.test(readFileSync(new URL(f, dir), 'utf8')));
			expect(ficheros, nombre).toEqual(['capacidades.ts']);
		}
	});
});
