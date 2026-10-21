import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
	EJECUTORES,
	MOTIVOS,
	elegir,
	fusionar,
	hechosDeConsola,
	hechosDeFormulario,
	hechosDeSensor,
	leerHoneycosa,
	leerTrampa,
	normalizar,
	validarHoneycosa,
	validarParametros,
	validarTrampa,
	type Capacidades,
	type CodigoMotivo,
	type ContextoElector,
	type DescripcionDestino,
	type Destino,
	type Eleccion,
	type EntradaElector,
	type Fuente,
	type Hechos,
	type Honeycosa,
	type ManifiestoTrampaV2,
	type Motivo,
	type MotorSensor,
	type Requisito,
	type TipoDestino,
	type TrampaDelCliente,
	type Via
} from './index.ts';

/*
 * El elector (docs/diseno/modulo-despliegue.md §7, paso 3): los 31 casos de
 * §7.5 en los dos modos, más los que hacen falta para que salga cada código
 * que puede devolver. Todas las entradas van congeladas en profundidad: si
 * elegir mutara algo, lanzaría.
 */

const raiz = join(import.meta.dirname, '../../..');
const leer = (...ruta: string[]) => readFileSync(join(raiz, ...ruta), 'utf8');

function congelar<T>(x: T): T {
	if (typeof x === 'object' && x !== null) {
		Object.values(x).forEach(congelar);
		Object.freeze(x);
	}
	return x;
}

function deObjeto(m: unknown): Honeycosa {
	const r = validarHoneycosa(m);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
}

function deYaml(yaml: string): Honeycosa {
	const r = leerHoneycosa(yaml);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
}

/* Las imágenes de los módulos cambian de digest al publicarse: las pruebas no dependen de eso. */
const PUBLICADA = `@sha256:${'a'.repeat(64)}`;
const EN_CEROS = `@sha256:${'0'.repeat(64)}`;
function conImagen(h: Honeycosa, digest: string): Honeycosa {
	const c = structuredClone(h);
	for (const v of c.vias)
		if (v.ejecutor === 'contenedor@1') {
			const carga = v.carga as { contenedor: { imagen: string } };
			carga.contenedor.imagen = carga.contenedor.imagen.replace(/@sha256:[0-9a-f]{64}$/, digest);
		}
	return c;
}

const cowrieYaml = leer('modulos/trampas/cowrie/trampa.yaml');
const smbYaml = leer('paquetes/contrato/src/ejemplos/smb.v2.yaml');
const cowrie = conImagen(deYaml(cowrieYaml), PUBLICADA);
const dnsNtp = conImagen(deYaml(leer('modulos/trampas/dns-ntp/trampa.yaml')), PUBLICADA);
const smb = conImagen(deYaml(smbYaml), PUBLICADA);
/* dns-ntp exige la IP de la máquina, que no tiene default. */
const DNS = { direccion: '10.20.0.5' };
const credencial = deYaml(leer('paquetes/contrato/src/ejemplos/credencial-ssh.v2.yaml'));

const smbObjeto = () => parse(smbYaml) as ManifiestoTrampaV2;

/* v1 tipo: fichero: no tiene ninguna vía. */
function ficheroV1(): Honeycosa {
	const r = leerTrampa(cowrieYaml);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	const { contenedor, aislamiento, ...resto } = r.valor;
	const t = validarTrampa({
		...resto,
		tipo: 'fichero',
		fichero: { plantilla: 'nominas.xlsx', baliza: 'http' },
		eventos: { ...r.valor.eventos, fuente: { tipo: 'rele' } }
	});
	if (!t.ok || !contenedor || !aislamiento) throw new Error('fichero v1');
	return normalizar(t.valor);
}

/* La vía contenedor de smb y otra manual@1 sin requisitos, con la fuente que se diga. */
function conManual(fuente: Fuente = { tipo: 'rele' }, antes?: string[]): Honeycosa {
	const m = smbObjeto();
	m.vias = [
		m.vias[0],
		{
			id: 'manual',
			...(antes ? { antes } : {}),
			ejecutor: 'manual@1',
			requisitos: [],
			carga: { lenguaje: 'ninguno', pasos: [{ texto: 'Comparte la carpeta ${recurso}.' }] },
			senal: { fuente },
			retirada: { tipo: 'manual', pasos: [{ texto: 'Deja de compartir ${recurso}.' }] }
		}
	];
	return conImagen(deObjeto(m), PUBLICADA);
}

/* Una vía servicio@1, que esta consola no conoce, delante de la contenedor de smb. */
function conServicio(): Honeycosa {
	const m = smbObjeto();
	m.vias = [
		{
			id: 'servicio',
			nombre: 'Como proceso del agente',
			ejecutor: 'servicio@1',
			requisitos: [],
			carga: { binario: 'smb', version: '1.0.0' },
			senal: { fuente: { tipo: 'fichero', ruta: 'smb.json' } },
			retirada: { tipo: 'automatica' }
		},
		m.vias[0]
	];
	return conImagen(deObjeto(m), PUBLICADA);
}

const avisaSinDato: Requisito = {
	hecho: 'plataforma.edicion',
	igual: 'servidor',
	nivel: 'avisa',
	siFalta: 'avisa',
	motivo: 'Es más creíble en un servidor'
};

/* Dos vías contenedor@1 iguales; la primera avisa de algo. */
function dosContenedores(): Honeycosa {
	const m = smbObjeto();
	const c = m.vias[0];
	m.vias = [
		{ ...structuredClone(c), id: 'a', requisitos: [avisaSinDato] },
		{ ...structuredClone(c), id: 'b' }
	];
	return conImagen(deObjeto(m), PUBLICADA);
}

/* Una honeycosa a mano, sin validar: lo que validarHoneycosa no dejaría pasar. */
function aMano(h: Honeycosa, cambiar: (v: Via[]) => void): Honeycosa {
	const c = structuredClone(h);
	cambiar(c.vias);
	return c;
}

const CUANDO = '2026-10-17T10:00:00Z';
const ROOTFUL: MotorSensor = {
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
};
const IP_REAL: Hechos = { 'red.ipOrigenReal': { valor: true, motivo: 'origen.real' } };

/*
 * Una máquina con sensor, con lo que daría hechosDe (§4.3): su fila (versión y
 * registro privado) y su sensores.capacidades. Por defecto, un 0.13.1 rootful
 * que ya ha visto la IP real.
 */
function conSensor(
	o: {
		id?: string;
		version?: string;
		vivo?: boolean;
		capacidades?: Capacidades | null;
		registroPrivado?: boolean | null;
		descripcion?: DescripcionDestino;
	} = {}
): Destino {
	const id = o.id ?? 'srv01';
	const version = o.version ?? '0.13.1';
	return {
		id,
		nombre: id,
		tipo: 'maquina',
		activo: true,
		agente: { sensor: id, version, vivo: o.vivo ?? true },
		hechos: fusionar(
			hechosDeFormulario(o.descripcion),
			hechosDeConsola({
				id,
				versionAgente: version,
				registroPrivado: o.registroPrivado === undefined ? true : o.registroPrivado
			}),
			hechosDeSensor(
				o.capacidades === undefined
					? { motor: ROOTFUL, hechos: IP_REAL, cuando: CUANDO }
					: o.capacidades && { ...o.capacidades, cuando: CUANDO }
			)
		)
	};
}

/* «Sensor 0.12»: agente vivo, versión 0.12.3 y solo los hechos que pone la consola. */
const sensor012 = () => conSensor({ id: 'srv012', version: '0.12.3', capacidades: null });
const motor = (m: MotorSensor, hechos: Hechos = {}) =>
	conSensor({ capacidades: { motor: m, hechos } });

/* Un destino descrito a mano (formulario corto), sin sensor. */
function sinSensor(tipo: TipoDestino, descripcion: DescripcionDestino = {}, id = 'fs01'): Destino {
	return {
		id,
		nombre: id,
		tipo,
		activo: true,
		agente: null,
		hechos: hechosDeFormulario(descripcion)
	};
}

/* Una Cowrie del cliente a la que puede apuntar credencial-ssh. */
function cowrieDelCliente(o: Partial<TrampaDelCliente> = {}): TrampaDelCliente {
	return {
		nombre: 'SSH de copias',
		modulo: 'cowrie',
		colocacion: 'comprobada',
		sensor: 'srv01',
		destino: 'srv01',
		destinoNombre: 'srv01',
		direccion: '10.20.0.5',
		marcas: [],
		...o
	};
}

const pcWindows = () => sinSensor('maquina', { so: 'windows', edicion: 'puesto' }, 'pc-admin');
const credencialEn = (objetivo: string, usuario = 'svc_sql4k7') => ({
	objetivo,
	usuario,
	sesion: 'srv-backup07'
});

function contexto(c: Partial<ContextoElector> = {}): ContextoElector {
	return {
		autorizado: true,
		ejecutoresConsola: ['contenedor@1', 'manual@1'],
		hechosNodo: {},
		trampasDelDestino: [],
		trampas: {},
		...c
	};
}

type Modo = 'reales' | 'sondeo';

/* Cada código que ha salido en alguna prueba, para comprobar al final que han salido todos. */
const vistos = new Set<CodigoMotivo>();

function motivosDe(r: Eleccion): Motivo[] {
	return [
		...(r.global ? [r.global] : []),
		...[...r.validas, ...r.descartadas].flatMap((v) => [...v.motivos, ...v.avisos])
	];
}

/* Ningún objeto de la salida está congelado: no comparte nada con la entrada (congelada). */
function sinCompartir(x: unknown, donde = 'salida'): void {
	if (typeof x !== 'object' || x === null) return;
	expect(Object.isFrozen(x), donde).toBe(false);
	for (const [k, v] of Object.entries(x)) sinCompartir(v, `${donde}.${k}`);
}

function correr(
	h: Honeycosa,
	d: Destino,
	c: Partial<ContextoElector>,
	p: Record<string, unknown>,
	modo: Modo
): Eleccion {
	const e: EntradaElector = congelar({
		honeycosa: structuredClone(h),
		destino: structuredClone(d),
		contexto: contexto(structuredClone(c)),
		parametros:
			modo === 'reales'
				? { modo, valor: validarParametros(h.parametros, p) }
				: { modo, valor: structuredClone(p) }
	});
	const r = elegir(e);
	/* El mismo input da el mismo output. */
	expect(elegir(e)).toEqual(r);
	sinCompartir(r);
	for (const m of motivosDe(r)) {
		vistos.add(m.codigo);
		expect(Object.hasOwn(MOTIVOS, m.codigo), m.codigo).toBe(true);
		expect(m.texto.trim(), m.codigo).not.toBe('');
		expect(m.texto, m.codigo).not.toMatch(/\{[A-Za-z]+\}/);
		if (m.remedio !== undefined) expect(m.remedio, m.codigo).not.toMatch(/\{[A-Za-z]+\}/);
	}
	/* Las descartadas, en el orden del manifiesto; cada vía sale una vez. */
	const ids = h.vias.map((v) => v.id);
	const desc = r.descartadas.map((v) => v.via);
	expect(desc).toEqual(ids.filter((id) => desc.includes(id)));
	if (r.validas.length || r.descartadas.length)
		expect([...r.validas, ...r.descartadas].map((v) => v.via).sort()).toEqual([...ids].sort());
	return r;
}

const GLOBALES: CodigoMotivo[] = [
	'modulo.no-autorizado',
	'modulo.sin-vias',
	'parametros.invalidos'
];

interface Esperado {
	elegida: string | null;
	/* Por defecto: null con elegida, elector.sin-via sin ella. */
	global?: CodigoMotivo;
	/* Los códigos exactos, en orden, de las vías que se nombran. */
	vias?: Record<string, { motivos?: CodigoMotivo[]; avisos?: CodigoMotivo[] }>;
	validas?: string[];
	ademas?: (r: Eleccion) => void;
}

function comprobar(r: Eleccion, x: Esperado) {
	expect(r.elegida?.via ?? null).toBe(x.elegida);
	const g = x.global ?? (x.elegida === null ? 'elector.sin-via' : null);
	expect(r.global?.codigo ?? null).toBe(g);
	if (r.elegida) expect(r.validas[0]).toEqual(r.elegida);
	expect(r.validas.every((v) => v.motivos.length === 0)).toBe(true);
	expect(r.descartadas.every((v) => v.motivos.length > 0)).toBe(true);
	if (g && GLOBALES.includes(g)) {
		expect(r.validas).toEqual([]);
		expect(r.descartadas).toEqual([]);
	}
	for (const [via, e] of Object.entries(x.vias ?? {})) {
		const v = [...r.validas, ...r.descartadas].find((y) => y.via === via);
		expect(v, via).toBeDefined();
		expect(
			v!.motivos.map((m) => m.codigo),
			`${via}: motivos`
		).toEqual(e.motivos ?? []);
		expect(
			v!.avisos.map((m) => m.codigo),
			`${via}: avisos`
		).toEqual(e.avisos ?? []);
	}
	if (x.validas) expect(r.validas.map((v) => v.via)).toEqual(x.validas);
	x.ademas?.(r);
}

const via = (r: Eleccion, id: string) =>
	[...r.validas, ...r.descartadas].find((v) => v.via === id)!;
const primero = (r: Eleccion, id: string, codigo: CodigoMotivo) =>
	[...via(r, id).motivos, ...via(r, id).avisos].find((m) => m.codigo === codigo)!;

interface Caso {
	/* El número de §7.5, con la variante si la hay. */
	n: string;
	titulo: string;
	h: Honeycosa;
	d: Destino;
	c?: Partial<ContextoElector>;
	p?: Record<string, unknown>;
	reales: Esperado;
	/* Por defecto, lo mismo que en reales. */
	sondeo?: Esperado;
}

const A = 'agente.anterior' as const;
const NO = 'requisito.no-cumple' as const;
const contenedorRequisitos = EJECUTORES['contenedor@1'].requisitos;
const remedioDe = (hecho: string) => contenedorRequisitos.find((r) => r.hecho === hecho)!.remedio;

const casos: Caso[] = [
	{
		n: '1',
		titulo: 'cowrie (v1) en un sensor 0.12',
		h: cowrie,
		d: sensor012(),
		reales: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: [A] } },
			ademas: (r) => {
				expect(r.elegida).toMatchObject({ clase: 'agente', nombre: 'En un sensor' });
				expect(r.elegida!.avisos[0].texto).toBe(
					'Este sensor no dice cómo es su máquina; se da por hecho que despliega contenedores.'
				);
			}
		}
	},
	{
		n: '2',
		titulo: 'cowrie en Docker Desktop',
		h: cowrie,
		d: motor({ ...ROOTFUL, modo: 'desktop' }),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: [NO] } },
			ademas: (r) => {
				const m = primero(r, 'contenedor', NO);
				expect(m).toMatchObject({
					hecho: 'motor.modo',
					esperado: { en: ['rootful'] },
					valor: 'desktop',
					remedio: remedioDe('motor.modo')
				});
				expect(m.texto).toBe(
					'Docker Desktop, Docker dentro de WSL y Docker o Podman sin root no dejan ver la IP del atacante (Cómo corre el motor: Docker Desktop).'
				);
				expect(r.global!.texto).toBe(
					'Ninguna forma de poner SSH y Telnet falsos vale en srv01; mira el motivo de cada una.'
				);
			}
		}
	},
	{
		n: '3',
		titulo: 'cowrie en un rootless que ya ha visto la IP del motor',
		h: cowrie,
		d: motor(
			{ ...ROOTFUL, modo: 'rootless' },
			{ 'red.ipOrigenReal': { valor: false, motivo: 'origen.rootless' } }
		),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: [NO, NO] } },
			ademas: (r) => {
				const [modo, ip] = via(r, 'contenedor').motivos;
				expect(modo).toMatchObject({ hecho: 'motor.modo', remedio: remedioDe('motor.modo') });
				expect(ip).toMatchObject({ hecho: 'red.ipOrigenReal', valor: false });
			}
		}
	},
	{
		n: '4',
		titulo: 'cowrie en arm64',
		h: cowrie,
		d: motor({ ...ROOTFUL, arquitectura: 'arm64' }, IP_REAL),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: [NO] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', NO)).toMatchObject({
					hecho: 'motor.arquitectura',
					valor: 'arm64'
				})
		}
	},
	{
		n: '5',
		titulo: 'cowrie con el motor caído (se conserva lo último bueno)',
		h: cowrie,
		d: motor(
			{
				tipo: 'docker',
				modo: 'rootful',
				so: 'linux',
				arquitectura: 'amd64',
				codigo: 'motor.inalcanzable',
				error: 'No se puede hablar con Docker.'
			},
			IP_REAL
		),
		reales: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: [NO] } },
			ademas: (r) =>
				expect(r.elegida!.avisos[0]).toMatchObject({
					hecho: 'motor.codigo',
					valor: 'motor.inalcanzable',
					texto:
						'El motor de contenedores falla ahora; la trampa esperará a que vuelva (Fallo del motor: motor.inalcanzable).'
				})
		}
	},
	{
		n: '6',
		titulo: 'cowrie en un servidor de ficheros Windows sin sensor',
		h: cowrie,
		d: sinSensor('fileserver', { so: 'windows' }),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['agente.falta'] } },
			ademas: (r) => {
				const m = primero(r, 'contenedor', 'agente.falta');
				expect(m.texto).toBe('Hace falta un sensor en fs01.');
				expect(m.remedio).toContain('appliance');
				expect(m.remedio).toContain('Hyper-V o VMware');
			}
		}
	},
	{
		n: '7',
		titulo: 'cowrie en un tenant',
		h: cowrie,
		d: sinSensor('tenant', {}, 'm365'),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['destino.tipo'] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'destino.tipo').texto).toBe(
					'Esta forma es para máquinas, servidores de ficheros o webs; m365 es un tenant de nube.'
				)
		}
	},
	{
		n: '8',
		titulo: 'cowrie en un destino dado de baja',
		h: cowrie,
		d: { ...conSensor(), activo: false },
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['destino.inactivo'] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'destino.inactivo').texto).toBe('srv01 está dado de baja.')
		}
	},
	{
		n: '9',
		titulo: 'dns-ntp (sensorMinimo 0.13.0) en un sensor 0.12',
		h: dnsNtp,
		d: sensor012(),
		p: DNS,
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['agente.version'], avisos: [A] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'agente.version')).toMatchObject({
					/* El texto de hoy en plan(), con mayúscula y punto. */
					texto:
						'Necesita un sensor 0.13.0 o posterior; este se pondrá al día con la próxima versión.',
					esperado: '0.13.0',
					valor: '0.12.3'
				})
		}
	},
	{
		n: '10',
		titulo: 'dns-ntp con puertoDns 53 y el udp/53 ocupado',
		h: dnsNtp,
		d: motor(ROOTFUL, {
			...IP_REAL,
			'puertos.ocupados': { valor: ['tcp/22', 'udp/53'], motivo: 'puertos.sonda' }
		}),
		p: { ...DNS, puertoDns: 53 },
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['puertos.ocupado'] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'puertos.ocupado')).toMatchObject({
					texto: 'srv01 ya usa el puerto UDP 53; elige otro o libéralo allí.',
					valor: 'udp/53'
				})
		},
		sondeo: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: ['puertos.ocupado'] } }
		}
	},
	{
		n: '11',
		titulo: 'cowrie con puertoSsh 2222 y otra trampa del destino en el tcp/2222',
		h: cowrie,
		d: conSensor(),
		c: {
			trampasDelDestino: [
				{
					id: 'ssh-viejo',
					nombre: 'SSH viejo',
					puertos: [{ puerto: 2222, protocolo: 'tcp', fijo: false, interno: 2222 }]
				}
			]
		},
		p: { puertoSsh: 2222 },
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['puertos.otra-trampa'] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'puertos.otra-trampa').texto).toBe(
					'El puerto 2222 ya lo usa la trampa SSH viejo en este destino.'
				)
		},
		sondeo: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: ['puertos.otra-trampa'] } }
		}
	},
	{
		n: '12',
		titulo: 'cowrie con puertoSsh 443 en el sensor local',
		h: cowrie,
		d: conSensor({ id: 'local' }),
		p: { puertoSsh: 443 },
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['puertos.reservado'] } },
			ademas: (r) =>
				/* El texto de hoy en choquesDePuertos. */
				expect(primero(r, 'contenedor', 'puertos.reservado').texto).toBe(
					'El puerto 443 de este nodo es el de la consola: elige otro.'
				)
		},
		sondeo: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: ['puertos.reservado'] } }
		}
	},
	{
		n: '12',
		titulo: 'un sensor que dice que el local no tiene reservas no quita la del 443',
		h: cowrie,
		d: conSensor({
			id: 'local',
			capacidades: {
				motor: ROOTFUL,
				hechos: { ...IP_REAL, 'puertos.reservados': { valor: [] } }
			}
		}),
		p: { puertoSsh: 443 },
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['puertos.reservado'] } }
		},
		sondeo: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: ['puertos.reservado'] } }
		}
	},
	{
		n: '13',
		titulo: 'un módulo con el digest en ceros',
		h: conImagen(cowrie, EN_CEROS),
		d: conSensor(),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['carga.imagen-sin-publicar'] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'carga.imagen-sin-publicar').texto).toBe(
					'La imagen de esta trampa aún no está publicada.'
				)
		}
	},
	{
		n: '14',
		titulo: 'cowrie sin imagenPublica en un sensor sin la credencial del registro',
		h: aMano(
			cowrie,
			(v) =>
				delete (v[0].carga as { contenedor: { imagenPublica?: string } }).contenedor.imagenPublica
		),
		d: conSensor({ registroPrivado: false }),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['carga.sin-credencial'] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'carga.sin-credencial').texto).toBe(
					'Este sensor aún no tiene la credencial del registro; se pondrá al día con su próxima versión.'
				)
		}
	},
	{
		n: '14',
		titulo: 'lo mismo sin saber si el sensor tiene la credencial',
		h: cowrie,
		d: conSensor({ registroPrivado: null }),
		reales: { elegida: 'contenedor', vias: { contenedor: {} } }
	},
	{
		n: '14',
		titulo: 'con imagenPublica, un sensor sin credencial recibe la pública',
		h: aMano(cowrie, (v) => {
			(v[0].carga as { contenedor: { imagenPublica?: string } }).contenedor.imagenPublica =
				'docker.io/cowrie/cowrie:2.6.1';
		}),
		d: conSensor({ registroPrivado: false }),
		reales: { elegida: 'contenedor', vias: { contenedor: {} } }
	},
	{
		n: '15',
		titulo: 'cowrie fuera de la suscripción',
		h: cowrie,
		d: conSensor(),
		c: { autorizado: false },
		reales: {
			elegida: null,
			global: 'modulo.no-autorizado',
			ademas: (r) => expect(r.global!.texto).toBe('SSH y Telnet falsos no entra en tu suscripción.')
		}
	},
	{
		n: '15',
		titulo: 'no autorizado se dice antes que sin vías',
		h: ficheroV1(),
		d: conSensor(),
		c: { autorizado: false },
		reales: { elegida: null, global: 'modulo.no-autorizado' }
	},
	{
		n: '16',
		titulo: 'un v1 tipo: fichero',
		h: ficheroV1(),
		d: conSensor(),
		reales: {
			elegida: null,
			global: 'modulo.sin-vias',
			ademas: (r) =>
				expect(r.global!.texto).toBe('Esta honeycosa aún no tiene ninguna forma de ponerse.')
		}
	},
	{
		n: '16',
		titulo: 'sin vías se dice antes que los parámetros',
		h: ficheroV1(),
		d: conSensor(),
		p: { puertoSsh: 'x' },
		reales: { elegida: null, global: 'modulo.sin-vias' }
	},
	{
		n: '17',
		titulo: 'cowrie con puertoSsh x',
		h: cowrie,
		d: conSensor(),
		p: { puertoSsh: 'x' },
		reales: {
			elegida: null,
			global: 'parametros.invalidos',
			ademas: (r) => {
				expect(r.global!.texto).toBe('Puerto SSH: no es del tipo esperado');
				expect(r.global!.valor).toEqual(['Puerto SSH: no es del tipo esperado']);
			}
		},
		/* En sondeo no se valida el esquema: eso se exige al guardar. */
		sondeo: { elegida: 'contenedor', vias: { contenedor: {} } }
	},
	{
		n: '18',
		titulo: 'smb (v2) en un sensor 0.13.1 rootful',
		h: smb,
		d: conSensor(),
		reales: {
			elegida: 'contenedor',
			vias: {
				contenedor: {},
				'carpeta-auditada': { motivos: ['destino.tipo'] }
			},
			ademas: (r) => {
				expect(r.elegida!.nombre).toBe('En un sensor');
				expect(primero(r, 'carpeta-auditada', 'destino.tipo').texto).toBe(
					'Esta forma es para servidores de ficheros; srv01 es una máquina.'
				);
			}
		}
	},
	{
		n: '19',
		titulo: 'smb en un servidor de ficheros Windows con PowerShell 5.1, sin sensor',
		h: smb,
		d: sinSensor('fileserver', { so: 'windows', powershell: '5.1', direccion: '10.20.0.9' }),
		reales: {
			elegida: null,
			vias: {
				contenedor: { motivos: ['agente.falta'] },
				'carpeta-auditada': { motivos: ['senal.sin-recolector'] }
			},
			ademas: (r) =>
				expect(primero(r, 'carpeta-auditada', 'senal.sin-recolector').texto).toBe(
					'Su señal sale del registro de eventos de Windows de fs01 y aún no hay recolector que lo lea (llega con el módulo de control).'
				)
		}
	},
	{
		n: '19',
		titulo: 'el mismo, el día que haya recolector (sin tocar el manifiesto)',
		h: smb,
		d: {
			...sinSensor('fileserver', { so: 'windows', powershell: '5.1' }),
			hechos: {
				...hechosDeFormulario({ so: 'windows', powershell: '5.1' }),
				'recolector.canales': { valor: ['windows-eventos'], fuente: 'sensor' }
			}
		},
		reales: {
			elegida: 'carpeta-auditada',
			vias: { contenedor: { motivos: ['agente.falta'] }, 'carpeta-auditada': {} },
			ademas: (r) =>
				expect(r.elegida).toMatchObject({
					clase: 'manual',
					nombre: 'En tu servidor de ficheros Windows'
				})
		}
	},
	{
		n: '20',
		titulo: 'smb en un servidor de ficheros Windows sin shell.powershell',
		h: smb,
		d: sinSensor('fileserver', { so: 'windows' }),
		reales: {
			elegida: null,
			vias: {
				contenedor: { motivos: ['agente.falta'] },
				'carpeta-auditada': { motivos: ['requisito.sin-dato', 'senal.sin-recolector'] }
			},
			ademas: (r) =>
				expect(primero(r, 'carpeta-auditada', 'requisito.sin-dato')).toMatchObject({
					hecho: 'shell.powershell',
					esperado: { minimo: '5.1' },
					texto:
						'Los pasos usan PowerShell 5.1 o posterior. Falta el dato «PowerShell»: dilo en la ficha de fs01, en Destinos.'
				})
		}
	},
	{
		n: '21',
		titulo: 'credencial-ssh en una máquina Windows hacia una Cowrie comprobada',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'ssh-1': cowrieDelCliente() } },
		p: credencialEn('ssh-1'),
		reales: {
			elegida: 'windows',
			vias: { windows: {}, linux: { motivos: [NO] } },
			ademas: (r) => {
				expect(r.elegida).toMatchObject({ clase: 'manual', nombre: 'Pasos para Windows' });
				expect(primero(r, 'linux', NO)).toMatchObject({
					hecho: 'plataforma.so',
					texto: 'Estos pasos son para Linux (Sistema operativo: Windows).'
				});
			}
		}
	},
	{
		n: '22',
		titulo: 'credencial-ssh con un objetivo que no existe',
		h: credencial,
		d: pcWindows(),
		c: {
			trampas: { 'ssh-1': cowrieDelCliente() },
			nombresModulos: { cowrie: 'SSH y Telnet falsos' }
		},
		p: credencialEn('ssh-9'),
		reales: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.trampa-objetivo'] },
				linux: { motivos: [NO, 'senal.trampa-objetivo'] }
			},
			/* Con el nombre del módulo para el cliente, no su id. */
			ademas: (r) =>
				expect(primero(r, 'windows', 'senal.trampa-objetivo').texto).toBe(
					'Necesita una trampa «SSH y Telnet falsos» puesta para recibir su señal.'
				)
		}
	},
	{
		n: '22',
		titulo: 'credencial-ssh con un objetivo retirando',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'ssh-1': cowrieDelCliente({ colocacion: 'retirando' }) } },
		p: credencialEn('ssh-1'),
		reales: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.trampa-objetivo'] },
				linux: { motivos: [NO, 'senal.trampa-objetivo'] }
			}
		}
	},
	{
		n: '22',
		titulo: 'credencial-ssh con un objetivo pendiente de poner',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'ssh-1': cowrieDelCliente({ colocacion: 'por-colocar' }) } },
		p: credencialEn('ssh-1'),
		reales: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.trampa-objetivo'] },
				linux: { motivos: [NO, 'senal.trampa-objetivo'] }
			}
		}
	},
	{
		n: '22',
		titulo: 'credencial-ssh con un objetivo de otro módulo',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'redis-1': cowrieDelCliente({ modulo: 'redis' }) } },
		p: credencialEn('redis-1'),
		reales: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.trampa-objetivo'] },
				linux: { motivos: [NO, 'senal.trampa-objetivo'] }
			}
		}
	},
	{
		n: '22',
		titulo: 'credencial-ssh hacia una Cowrie degradada (sigue recibiendo)',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'ssh-1': cowrieDelCliente({ colocacion: 'degradada' }) } },
		p: credencialEn('ssh-1'),
		reales: { elegida: 'windows', vias: { windows: {}, linux: { motivos: [NO] } } }
	},
	{
		n: '23',
		titulo: 'una vía servicio@1 y otra contenedor@1',
		h: conServicio(),
		d: conSensor(),
		reales: {
			elegida: 'contenedor',
			vias: {
				servicio: { motivos: ['ejecutor.desconocido'] },
				contenedor: {}
			},
			ademas: (r) => {
				expect(via(r, 'servicio')).toMatchObject({
					clase: null,
					nombre: 'Como proceso del agente'
				});
				expect(primero(r, 'servicio', 'ejecutor.desconocido').texto).toBe(
					'Esta forma (servicio@1) llegará con una versión más nueva de Sugardaddy.'
				);
			}
		}
	},
	{
		n: '24',
		titulo: 'smb en un sensor con la preferida carpeta-auditada, que no vale',
		h: smb,
		d: conSensor(),
		c: { preferida: 'carpeta-auditada' },
		reales: {
			elegida: 'contenedor',
			vias: { contenedor: {}, 'carpeta-auditada': { motivos: ['destino.tipo'] } }
		}
	},
	{
		n: '25',
		titulo: 'contenedor@1 y manual@1, sin preferida',
		h: conManual(),
		d: conSensor(),
		c: { hechosNodo: { 'canal.rele': { valor: true, fuente: 'consola' } } },
		reales: {
			elegida: 'contenedor',
			validas: ['contenedor', 'manual'],
			vias: { contenedor: {}, manual: {} }
		}
	},
	{
		n: '25',
		titulo: 'contenedor@1 y manual@1, con preferida manual',
		h: conManual(),
		d: conSensor(),
		c: { hechosNodo: { 'canal.rele': { valor: true, fuente: 'consola' } }, preferida: 'manual' },
		reales: { elegida: 'manual', validas: ['manual', 'contenedor'] }
	},
	{
		n: '25',
		titulo: 'la preferida también por un id de antes',
		h: conManual({ tipo: 'rele' }, ['a-mano']),
		d: conSensor(),
		c: { hechosNodo: { 'canal.rele': { valor: true, fuente: 'consola' } }, preferida: 'a-mano' },
		reales: { elegida: 'manual', validas: ['manual', 'contenedor'] }
	},
	{
		n: '25',
		titulo: 'de la misma clase, primero la que no avisa',
		h: dosContenedores(),
		d: conSensor({
			capacidades: {
				motor: ROOTFUL,
				hechos: { ...IP_REAL, 'agente.ejecutores': { valor: ['contenedor@1'] } }
			}
		}),
		reales: {
			elegida: 'b',
			validas: ['b', 'a'],
			vias: { a: { avisos: ['requisito.sin-dato'] }, b: {} }
		}
	},
	{
		n: '26',
		titulo: 'un requisito nivel: avisa, siFalta: avisa sin el hecho',
		h: aMano(cowrie, (v) => v[0].requisitos.push(avisaSinDato)),
		d: conSensor(),
		reales: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: ['requisito.sin-dato'] } },
			ademas: (r) =>
				expect(r.elegida!.avisos[0].texto).toBe(
					'Es más creíble en un servidor. Falta el dato «Edición»: dilo en la ficha de srv01, en Destinos.'
				)
		}
	},
	{
		n: '27',
		titulo: 'credencial-ssh hacia una Cowrie cuyo destino no tiene dirección',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'ssh-1': cowrieDelCliente({ direccion: undefined }) } },
		p: credencialEn('ssh-1'),
		reales: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.objetivo-sin-direccion'] },
				linux: { motivos: [NO, 'senal.objetivo-sin-direccion'] }
			},
			ademas: (r) =>
				expect(primero(r, 'windows', 'senal.objetivo-sin-direccion')).toMatchObject({
					texto:
						'Lo sembrado tiene que apuntar a la dirección de SSH de copias, y srv01 no la tiene.',
					remedio: 'Pon la dirección de srv01 en Destinos.'
				})
		}
	},
	{
		n: '28',
		titulo: 'credencial-ssh sin parámetros, con una Cowrie con dirección',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'ssh-1': cowrieDelCliente() } },
		/* Al guardar, los obligatorios sin valor sí cuentan. */
		reales: { elegida: null, global: 'parametros.invalidos' },
		sondeo: { elegida: 'windows', vias: { windows: {}, linux: { motivos: [NO] } } }
	},
	{
		n: '28',
		titulo: 'credencial-ssh sin parámetros y sin ninguna Cowrie',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'web-1': cowrieDelCliente({ modulo: 'retencion-web' }) } },
		reales: { elegida: null, global: 'parametros.invalidos' },
		sondeo: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.trampa-objetivo'] },
				linux: { motivos: [NO, 'senal.trampa-objetivo'] }
			}
		}
	},
	{
		n: '28',
		titulo: 'credencial-ssh sin parámetros y con una Cowrie retirando',
		h: credencial,
		d: pcWindows(),
		c: { trampas: { 'ssh-1': cowrieDelCliente({ colocacion: 'retirando' }) } },
		reales: { elegida: null, global: 'parametros.invalidos' },
		sondeo: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.trampa-objetivo'] },
				linux: { motivos: [NO, 'senal.trampa-objetivo'] }
			}
		}
	},
	{
		n: '28',
		titulo: 'credencial-ssh sin parámetros y con Cowries sin dirección',
		h: credencial,
		d: pcWindows(),
		c: {
			trampas: {
				'ssh-1': cowrieDelCliente({ direccion: undefined }),
				'ssh-2': cowrieDelCliente({ direccion: '', nombre: 'SSH dos' })
			}
		},
		reales: { elegida: null, global: 'parametros.invalidos' },
		sondeo: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.objetivo-sin-direccion'] },
				linux: { motivos: [NO, 'senal.objetivo-sin-direccion'] }
			}
		}
	},
	{
		n: '28',
		titulo: 'credencial-ssh sin parámetros: basta una Cowrie con dirección entre varias',
		h: credencial,
		d: pcWindows(),
		c: {
			trampas: {
				'ssh-1': cowrieDelCliente({ direccion: undefined }),
				'ssh-2': cowrieDelCliente({ nombre: 'SSH dos' })
			}
		},
		reales: { elegida: null, global: 'parametros.invalidos' },
		sondeo: { elegida: 'windows', vias: { windows: {}, linux: { motivos: [NO] } } }
	},
	{
		n: '29',
		titulo: 'credencial-ssh con un usuario que ya usa otra credencial contra la misma Cowrie',
		h: credencial,
		d: pcWindows(),
		c: {
			trampas: {
				'ssh-1': cowrieDelCliente({
					marcas: [
						{
							id: 'cred-fs02',
							nombre: 'Credencial de fs02',
							marca: { campo: 'origen.usuario', igual: 'SVC_SQL4K7' }
						}
					]
				})
			}
		},
		p: credencialEn('ssh-1', 'svc_sql4k7'),
		reales: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.marca-repetida'] },
				linux: { motivos: [NO, 'senal.marca-repetida'] }
			},
			ademas: (r) =>
				expect(primero(r, 'windows', 'senal.marca-repetida')).toMatchObject({
					texto:
						'La trampa Credencial de fs02 ya usa «SVC_SQL4K7» contra SSH de copias: elige otro valor para saber cuál de las dos se ha usado.',
					valor: 'svc_sql4k7'
				})
		},
		/* En sondeo no se mira la marca. */
		sondeo: { elegida: 'windows', vias: { windows: {}, linux: { motivos: [NO] } } }
	},
	{
		n: '29',
		titulo: 'el mismo usuario contra otra Cowrie sí vale',
		h: credencial,
		d: pcWindows(),
		c: {
			trampas: {
				'ssh-1': cowrieDelCliente({
					marcas: [
						{
							id: 'cred-fs02',
							nombre: 'Credencial de fs02',
							marca: { campo: 'origen.usuario', igual: 'SVC_SQL4K7' }
						}
					]
				}),
				'ssh-2': cowrieDelCliente({ nombre: 'SSH dos', direccion: '10.20.0.6' })
			}
		},
		p: credencialEn('ssh-2', 'svc_sql4k7'),
		reales: { elegida: 'windows', vias: { windows: {}, linux: { motivos: [NO] } } }
	},
	{
		n: '29',
		titulo: 'un contiene de otra credencial que cabe en el usuario también se solapa',
		h: credencial,
		d: pcWindows(),
		c: {
			trampas: {
				'ssh-1': cowrieDelCliente({
					marcas: [
						{ id: 'x', nombre: 'Otra', marca: { campo: 'origen.usuario', contiene: 'SQL4' } }
					]
				})
			}
		},
		p: credencialEn('ssh-1', 'svc_sql4k7'),
		reales: {
			elegida: null,
			vias: {
				windows: { motivos: ['senal.marca-repetida'] },
				linux: { motivos: [NO, 'senal.marca-repetida'] }
			}
		},
		sondeo: { elegida: 'windows' }
	},
	{
		n: '29',
		titulo: 'marcas de otro campo o de otro valor no se solapan',
		h: credencial,
		d: pcWindows(),
		c: {
			trampas: {
				'ssh-1': cowrieDelCliente({
					marcas: [
						{ id: 'x', nombre: 'Otra', marca: { campo: 'origen.ip', igual: 'svc_sql4k7' } },
						{ id: 'y', nombre: 'Y', marca: { campo: 'origen.usuario', igual: 'svc_sql4k8' } },
						{ id: 'z', nombre: 'Z', marca: { campo: 'origen.usuario', contiene: 'svc_sql4k70' } }
					]
				})
			}
		},
		p: credencialEn('ssh-1', 'svc_sql4k7'),
		reales: { elegida: 'windows', vias: { windows: {}, linux: { motivos: [NO] } } }
	},
	{
		n: '30',
		titulo: 'cowrie con el puerto por defecto (2222) ocupado en el destino',
		h: cowrie,
		d: motor(ROOTFUL, {
			...IP_REAL,
			'puertos.ocupados': { valor: ['tcp/2222'], motivo: 'puertos.sonda' }
		}),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['puertos.ocupado'] } }
		},
		sondeo: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: ['puertos.ocupado'] } },
			ademas: (r) =>
				expect(r.elegida!.avisos[0].texto).toBe(
					'srv01 ya usa el puerto TCP 2222; elige otro o libéralo allí.'
				)
		}
	},
	{
		n: '31',
		titulo: 'cowrie en un rootful que ha visto la IP de la pasarela',
		h: cowrie,
		d: motor(ROOTFUL, { 'red.ipOrigenReal': { valor: false, motivo: 'origen.pasarela' } }),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: [NO] } },
			ademas: (r) => {
				const m = primero(r, 'contenedor', NO);
				expect(m).toMatchObject({ hecho: 'red.ipOrigenReal', valor: false });
				expect(m.remedio).toContain('«Probar»');
			}
		}
	},
	{
		n: '31',
		titulo: 'el mismo con la IP real',
		h: cowrie,
		d: motor(ROOTFUL, IP_REAL),
		reales: { elegida: 'contenedor', vias: { contenedor: {} } }
	},
	{
		n: '31',
		titulo: 'el mismo sin el hecho (aún no ha llegado nada)',
		h: cowrie,
		d: motor(ROOTFUL),
		reales: { elegida: 'contenedor', vias: { contenedor: {} } }
	}
];

/* Lo que §7.5 no tiene y hace falta para que salga cada código. */
const otros: Caso[] = [
	{
		n: 'A',
		titulo: 'un sensor que dice sus ejecutores y no tiene contenedor@1',
		h: cowrie,
		d: conSensor({
			capacidades: {
				motor: ROOTFUL,
				hechos: { ...IP_REAL, 'agente.ejecutores': { valor: ['servicio@1'] } }
			}
		}),
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['agente.sin-ejecutor'] } },
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'agente.sin-ejecutor')).toMatchObject({
					texto:
						'El sensor de srv01 aún no sabe hacer esto; se pondrá al día con su próxima versión.',
					valor: ['servicio@1']
				})
		}
	},
	{
		n: 'A',
		titulo: 'un sensor que dice que tiene contenedor@1 no avisa de agente.anterior',
		h: cowrie,
		d: conSensor({
			capacidades: {
				motor: ROOTFUL,
				hechos: { ...IP_REAL, 'agente.ejecutores': { valor: ['contenedor@1'] } }
			}
		}),
		reales: { elegida: 'contenedor', vias: { contenedor: {} } }
	},
	{
		n: 'A',
		titulo:
			'un 0.13.1 que dice cómo es su motor pero no qué ejecuta no avisa de agente.anterior; sin decir nada, sí',
		h: cowrie,
		d: conSensor(),
		reales: {
			elegida: 'contenedor',
			vias: { contenedor: {} },
			ademas: () => {
				/* La consola pone agente.ejecutores por él, como en un 0.12. */
				expect(conSensor().hechos['agente.ejecutores']).toMatchObject({
					fuente: 'consola',
					motivo: 'agente.anterior'
				});
				const callado = conSensor({ capacidades: { motor: null, hechos: {} } });
				const r = correr(cowrie, callado, {}, {}, 'reales');
				expect(via(r, 'contenedor').avisos.map((m) => m.codigo)).toEqual([A]);
			}
		}
	},
	{
		n: 'B',
		titulo: 'un sensor sin latido',
		h: cowrie,
		d: conSensor({ vivo: false }),
		reales: {
			elegida: 'contenedor',
			vias: { contenedor: { avisos: ['agente.sin-contacto'] } },
			ademas: (r) =>
				expect(r.elegida!.avisos[0].texto).toBe(
					'El sensor de srv01 no contesta; la trampa se pondrá cuando vuelva.'
				)
		}
	},
	{
		n: 'B',
		titulo: 'un sensor con una versión que no es x.y.z, para una vía con sensorMinimo',
		h: dnsNtp,
		d: conSensor({ version: '0.13.1-rc1' }),
		p: DNS,
		reales: { elegida: null, vias: { contenedor: { motivos: ['agente.version'] } } }
	},
	{
		n: 'B',
		titulo: 'un sensor dev sirve para cualquier sensorMinimo',
		h: dnsNtp,
		d: conSensor({ version: 'dev' }),
		p: DNS,
		reales: { elegida: 'contenedor', vias: { contenedor: {} } }
	},
	{
		n: 'C',
		titulo: 'una vía con la señal por el relé en un nodo sin relé',
		h: conManual({ tipo: 'rele' }),
		d: sinSensor('fileserver', { so: 'linux' }),
		reales: {
			elegida: null,
			vias: {
				contenedor: { motivos: ['agente.falta'] },
				manual: { motivos: ['senal.sin-rele'] }
			},
			ademas: (r) =>
				expect(primero(r, 'contenedor', 'agente.falta').remedio).toBe(
					'Instala un sensor en fs01: en Sensores, «Instalar un sensor en otra máquina».'
				)
		}
	},
	{
		n: 'C',
		titulo: 'la misma con relé',
		h: conManual({ tipo: 'rele' }),
		d: sinSensor('fileserver', { so: 'linux' }),
		c: { hechosNodo: { 'canal.rele': { valor: true, fuente: 'consola' } } },
		reales: { elegida: 'manual', vias: { contenedor: { motivos: ['agente.falta'] }, manual: {} } }
	},
	{
		n: 'D',
		titulo: 'una vía por conector sin la conexión',
		h: conManual({ tipo: 'conector', conexion: 'graph' }),
		d: sinSensor('tenant', {}, 'm365'),
		reales: {
			elegida: null,
			vias: {
				contenedor: { motivos: ['destino.tipo'] },
				manual: { motivos: ['senal.sin-conexion'] }
			},
			ademas: (r) =>
				expect(primero(r, 'manual', 'senal.sin-conexion').texto).toBe(
					'Hay que conectar Microsoft 365 primero.'
				)
		}
	},
	{
		n: 'D',
		titulo: 'la misma con la conexión activa',
		h: conManual({ tipo: 'conector', conexion: 'graph' }),
		d: sinSensor('tenant', {}, 'm365'),
		c: { hechosNodo: { 'conexion.graph.estado': { valor: 'activa', fuente: 'consola' } } },
		reales: { elegida: 'manual' }
	},
	{
		n: 'E',
		titulo: 'una fuente que el ejecutor no admite (a mano: validarHoneycosa no la deja pasar)',
		h: aMano(conManual(), (v) => {
			v[0].senal = { fuente: { tipo: 'rele' } };
			v[1].senal = { fuente: { tipo: 'fichero', ruta: 'smb.json' } };
		}),
		d: conSensor(),
		reales: {
			elegida: null,
			vias: {
				contenedor: { motivos: ['senal.inalcanzable'] },
				manual: { motivos: ['senal.inalcanzable'] }
			}
		}
	},
	{
		n: 'F',
		titulo: 'un ejecutor que el código conoce pero esta consola no ofrece',
		h: conManual(),
		d: conSensor(),
		c: {
			ejecutoresConsola: ['contenedor@1'],
			hechosNodo: { 'canal.rele': { valor: true, fuente: 'consola' } }
		},
		reales: {
			elegida: 'contenedor',
			vias: { manual: { motivos: ['ejecutor.desconocido'] } },
			ademas: (r) => expect(via(r, 'manual').clase).toBeNull()
		}
	},
	{
		n: 'G',
		titulo: 'un tipo de destino que esta consola no conoce (contrato abierto)',
		h: conManual(),
		d: { ...sinSensor('otro'), tipo: 'impresora' as TipoDestino },
		reales: {
			elegida: null,
			vias: {
				contenedor: { motivos: ['destino.tipo'] },
				manual: { motivos: ['destino.tipo'] }
			},
			ademas: (r) =>
				expect(primero(r, 'manual', 'destino.tipo').texto).toBe(
					'Esta forma es para máquinas, servidores de ficheros, webs, webs en PaaS, cuentas de hosting, directorios activos, tenants de nube, servicios SaaS o otros destinos; fs01 es impresora.'
				)
		}
	},
	{
		n: 'H',
		titulo: 'dos puertos que chocan con la misma trampa salen una vez',
		h: dnsNtp,
		d: conSensor(),
		p: DNS,
		c: {
			trampasDelDestino: [
				{
					id: 'dns-viejo',
					nombre: 'DNS viejo',
					puertos: [
						{ puerto: 53, protocolo: 'udp', fijo: false, interno: 1053 },
						{ puerto: 53, protocolo: 'tcp', fijo: false, interno: 1053 }
					]
				}
			]
		},
		reales: {
			elegida: null,
			vias: { contenedor: { motivos: ['puertos.otra-trampa'] } }
		},
		sondeo: { elegida: 'contenedor', vias: { contenedor: { avisos: ['puertos.otra-trampa'] } } }
	}
];

describe('elector: casos de §7.5', () => {
	it('están los 31', () => {
		expect([...new Set(casos.map((c) => c.n))]).toEqual(
			Array.from({ length: 31 }, (_, i) => String(i + 1))
		);
	});

	for (const caso of [...casos, ...otros])
		for (const modo of ['reales', 'sondeo'] as const)
			it(`${caso.n}. ${caso.titulo} (${modo})`, () => {
				const r = correr(caso.h, caso.d, caso.c ?? {}, caso.p ?? {}, modo);
				comprobar(r, modo === 'sondeo' ? (caso.sondeo ?? caso.reales) : caso.reales);
			});
});

describe('elector: lo demás', () => {
	it('el remedio de agente.falta depende de plataforma.so', () => {
		const remedio = (so?: DescripcionDestino['so']) => {
			const r = correr(cowrie, sinSensor('maquina', so ? { so } : {}), {}, {}, 'reales');
			return primero(r, 'contenedor', 'agente.falta').remedio;
		};
		expect(remedio('linux')).toContain('Instalar un sensor en otra máquina');
		expect(remedio('windows')).toContain('appliance');
		expect(remedio('macos')).toBe(
			'En macOS hará falta el agente nativo, que llegará más adelante.'
		);
		expect(remedio()).toContain('appliance');
		expect(remedio('nas')).toContain('appliance');
	});

	it('requisito.no-cumple de un hecho que falta (presente: true) no dice «undefined»', () => {
		const h = aMano(cowrie, (v) =>
			v[0].requisitos.push({ hecho: 'canal.panel', presente: true, motivo: 'Necesita el panel.' })
		);
		const r = correr(h, conSensor(), {}, {}, 'reales');
		const m = primero(r, 'contenedor', NO);
		expect(m.texto).toBe('Necesita el panel (canal.panel: no se sabe).');
		expect(m).not.toHaveProperty('valor');
	});

	it('un hecho del destino gana al del nodo', () => {
		const h = conManual({ tipo: 'rele' });
		const d = {
			...sinSensor('fileserver'),
			hechos: { 'canal.rele': { valor: false, fuente: 'sensor' as const } }
		};
		const c = { hechosNodo: { 'canal.rele': { valor: true, fuente: 'consola' as const } } };
		expect(correr(h, d, c, {}, 'reales').elegida).toBeNull();
	});

	it('una marca con un hueco que el elector no sabe no se compara', () => {
		const h = aMano(credencial, (v) => {
			v[0].senal.fuente = {
				tipo: 'trampa',
				trampa: '${objetivo}',
				marca: { campo: 'origen.usuario', igual: '${usuario}-${trampa.id}' }
			};
		});
		const c = {
			trampas: {
				'ssh-1': cowrieDelCliente({
					marcas: [{ id: 'x', nombre: 'X', marca: { campo: 'origen.usuario', contiene: 'svc' } }]
				})
			}
		};
		const r = correr(h, pcWindows(), c, credencialEn('ssh-1'), 'reales');
		expect(via(r, 'windows').motivos).toEqual([]);
		/* La de Linux, que no tiene el hueco, sí. */
		expect(via(r, 'linux').motivos.map((m) => m.codigo)).toContain('senal.marca-repetida');
	});

	it('el destino y la dirección del objetivo también sirven en una marca', () => {
		const h = aMano(credencial, (v) => {
			v[0].senal.fuente = {
				tipo: 'trampa',
				trampa: '${objetivo}',
				marca: { campo: 'detalle.ruta', igual: '${destino.nombre}@${objetivo.direccion}' }
			};
		});
		const c = {
			trampas: {
				'ssh-1': cowrieDelCliente({
					marcas: [
						{ id: 'x', nombre: 'X', marca: { campo: 'detalle.ruta', igual: 'PC-ADMIN@10.20.0.5' } }
					]
				})
			}
		};
		const r = correr(h, pcWindows(), c, credencialEn('ssh-1'), 'reales');
		expect(via(r, 'windows').motivos.map((m) => m.codigo)).toEqual(['senal.marca-repetida']);
	});

	it('las marcas de la base de datos que no tienen la forma del contrato no hacen fallar nada', () => {
		const c = {
			trampas: {
				'ssh-1': cowrieDelCliente({
					marcas: [
						{ id: 'x', nombre: 'X', marca: { campo: 'origen.usuario' } as never },
						{ id: 'y', nombre: 'Y', marca: { campo: 'origen.usuario', igual: 7 } as never },
						{ id: 'z', nombre: 'Z', marca: null as never }
					]
				})
			}
		};
		const r = correr(credencial, pcWindows(), c, credencialEn('ssh-1'), 'reales');
		expect(r.elegida?.via).toBe('windows');
	});

	it('en sondeo, lo que pasa el cliente gana a los default, y lo vacío no cuenta', () => {
		const d = motor(ROOTFUL, {
			...IP_REAL,
			'puertos.ocupados': { valor: ['tcp/2222'], motivo: 'puertos.sonda' }
		});
		const avisos = (p: Record<string, unknown>) =>
			correr(cowrie, d, {}, p, 'sondeo').elegida!.avisos.map((m) => m.codigo);
		expect(avisos({})).toContain('puertos.ocupado');
		expect(avisos({ puertoSsh: '' })).toContain('puertos.ocupado');
		expect(avisos({ puertoSsh: 22 })).not.toContain('puertos.ocupado');
	});

	it('todo lo que devuelve tiene texto en motivos.ts, y han salido todos los códigos del elector', () => {
		/* Los que no da el elector: los del plan (paso 8) y del estado visible (paso 10). */
		const deOtros: CodigoMotivo[] = [
			'modulo.desconocido',
			'modulo.via-desaparecida',
			'licencia.sin',
			'licencia.caducada',
			'senal.objetivo-retirado',
			'senal.objetivo-parado',
			'senal.objetivo-cambiado'
		];
		const delElector = (Object.keys(MOTIVOS) as CodigoMotivo[]).filter((c) => !deOtros.includes(c));
		expect([...vistos].sort()).toEqual(delElector.sort());
	});

	it('elector.ts y lo que importa no usan nada de node: ni paquetes', () => {
		const vistosFicheros = new Set<string>();
		const fuera: string[] = [];
		const recorrer = (fichero: string) => {
			if (vistosFicheros.has(fichero)) return;
			vistosFicheros.add(fichero);
			const fuente = readFileSync(fichero, 'utf8');
			for (const m of fuente.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)) {
				const [, soloTipos, ruta] = m;
				if (soloTipos) continue;
				if (ruta.startsWith('./')) recorrer(join(dirname(fichero), ruta));
				else fuera.push(`${fichero}: ${ruta}`);
			}
			expect(fuente, fichero).not.toMatch(/['"]node:/);
		};
		recorrer(join(import.meta.dirname, 'elector.ts'));
		expect(fuera).toEqual([]);
		expect([...vistosFicheros].map((f) => f.split('/').pop()).sort()).toEqual(
			[
				'capacidades.ts',
				'ejecutores.ts',
				'elector.ts',
				'hechos.ts',
				'honeycosa.ts',
				'motivos.ts',
				'puertos.ts',
				'requisitos.ts'
			].sort()
		);
	});
});

describe('ejecutores', () => {
	it('contenedor@1 y manual@1, como dicen §6.2 y §6.3', () => {
		expect(Object.keys(EJECUTORES).sort()).toEqual(['contenedor@1', 'manual@1']);
		for (const [id, e] of Object.entries(EJECUTORES)) expect(e.id).toBe(id);
		expect(EJECUTORES['contenedor@1']).toMatchObject({
			clase: 'agente',
			corre: 'agente',
			destinos: ['maquina', 'fileserver', 'web'],
			fuentes: ['fichero'],
			pausable: true,
			retirada: 'automatica'
		});
		expect(EJECUTORES['manual@1']).toMatchObject({
			clase: 'manual',
			corre: 'consola',
			fuentes: ['trampa', 'registros', 'rele', 'conector'],
			requisitos: [],
			pausable: false,
			retirada: 'confirmada'
		});
		expect(EJECUTORES['manual@1'].destinos).toHaveLength(9);
		expect(contenedorRequisitos.map((r) => r.hecho)).toEqual([
			'motor.modo',
			'motor.arquitectura',
			'red.ipOrigenReal',
			'motor.codigo'
		]);
	});

	it('nadie puede cambiarlos', () => {
		expect(Object.isFrozen(EJECUTORES)).toBe(true);
		expect(Object.isFrozen(EJECUTORES['contenedor@1'].requisitos[0])).toBe(true);
		expect(Object.isFrozen(EJECUTORES['manual@1'].destinos)).toBe(true);
	});

	it('sus requisitos están dentro del lenguaje (validarHoneycosa los admite en una vía)', () => {
		const m = smbObjeto();
		m.vias[0].requisitos = structuredClone([...contenedorRequisitos]);
		expect(validarHoneycosa(m).ok).toBe(true);
	});
});
