import type { Hechos } from './capacidades.ts';
import { EJECUTORES, type ClaseEjecutor, type Ejecutor } from './ejecutores.ts';
import { HECHOS, nombreHecho, valorVisible } from './hechos.ts';
import { viaDe } from './honeycosa.ts';
import { motivo, type Motivo } from './motivos.ts';
import type { Puerto } from './puertos.ts';
import { OPERADORES, efectoRequisito, evaluarRequisito } from './requisitos.ts';
import type {
	EsquemaParametros,
	Fuente,
	Honeycosa,
	IdEjecutor,
	Marca,
	Requisito,
	Slug,
	TipoDestino,
	Via
} from './tipos.ts';
import type { Resultado } from './validar.ts';

/*
 * El elector (docs/diseno/modulo-despliegue.md §7): dada una honeycosa, un
 * destino con sus hechos y los parámetros, qué vía vale, cuál se elige y por
 * qué no valen las demás. Puro: sin base de datos, ficheros, red ni reloj, y
 * sin nada de node:, para que lo use igual la consola al dar de alta y en
 * Destinos que el panel en el catálogo por cohorte. No muta su entrada y el
 * mismo input da el mismo output.
 */

export type Colocacion = 'por-colocar' | 'colocada' | 'comprobada' | 'degradada' | 'retirando';

export interface Destino {
	id: Slug;
	nombre: string;
	/* Contrato abierto: un tipo que esta consola no conoce no vale para ninguna vía. */
	tipo: TipoDestino;
	activo: boolean;
	agente: { sensor: Slug; version?: string; vivo: boolean } | null;
	/* Ya fusionados (hechosDe, §4.3). */
	hechos: Hechos;
}

/* Una trampa del cliente, para la fuente «trampa» (§2.4). */
export interface TrampaDelCliente {
	nombre: string;
	modulo: string;
	colocacion: Colocacion;
	sensor: string;
	destino: string;
	destinoNombre: string;
	/* destino.direccion de su destino. */
	direccion?: string;
	/* Las de las trampas que ya apuntan a ella (menos la que se modifica). */
	marcas: { id: string; nombre: string; marca: Marca }[];
}

export interface ContextoElector {
	/* El módulo entra en la suscripción. */
	autorizado: boolean;
	/* Los ejecutores de esta consola: ['contenedor@1', 'manual@1']. */
	ejecutoresConsola: IdEjecutor[];
	/* Hechos del nodo (canal.rele…). Los del destino ganan si se repite una clave. */
	hechosNodo: Hechos;
	/* Trampas activas del mismo destino (menos la que se modifica), con sus puertos. */
	trampasDelDestino: { id: string; nombre: string; puertos: Puerto[]; escucha?: string | null }[];
	/*
	 * La dirección de la máquina en la que se publicaría la trampa que se mira:
	 * una de las suyas; null, en todas; sin indicar, aún no se ha elegido (el paso
	 * «¿dónde?»): entonces vale el destino si queda alguna forma de ponerla.
	 */
	escucha?: string | null;
	/* Para la fuente «trampa»: las trampas del cliente por id. */
	trampas: Record<string, TrampaDelCliente>;
	/* La vía que eligió el cliente (también por un id de «antes»). */
	preferida?: Slug;
	/* El nombre de cada módulo del catálogo, por id, para los textos («SSH y Telnet falsos»). */
	nombresModulos?: Record<string, string>;
}

export interface EntradaElector {
	honeycosa: Honeycosa;
	destino: Destino;
	/*
	 * reales: al guardar o modificar, con lo que ha escrito el cliente (de validarParametros).
	 * sondeo: antes de que haya formulario («¿dónde?», Destinos, Catálogo), §7.2.
	 */
	parametros:
		| { modo: 'reales'; valor: Resultado<Record<string, unknown>> }
		| { modo: 'sondeo'; valor?: Record<string, unknown> };
	contexto: ContextoElector;
}

export interface ViaEvaluada {
	via: Slug;
	ejecutor: IdEjecutor;
	nombre: string;
	/* null si esta consola no conoce el ejecutor. */
	clase: ClaseEjecutor | null;
	/* Vacío: la vía vale. */
	motivos: Motivo[];
	avisos: Motivo[];
}

export interface Eleccion {
	elegida: ViaEvaluada | null;
	/* En orden de preferencia; la primera es la elegida. */
	validas: ViaEvaluada[];
	/* En el orden del manifiesto. */
	descartadas: ViaEvaluada[];
	/* Un motivo que afecta a todas (y entonces no se evalúa ninguna), o elector.sin-via. */
	global: Motivo | null;
}

type Modo = EntradaElector['parametros']['modo'];

/* Las colocaciones en que una trampa recibe y puede ser la señal de otra (§2.4). */
const RECIBEN: readonly Colocacion[] = ['colocada', 'comprobada', 'degradada'];

const ORDEN_CLASE: Record<ClaseEjecutor, number> = { agente: 0, conector: 1, manual: 2 };

/* Cómo se nombra cada tipo de destino en un texto: para varios y para uno. */
const TIPOS: Record<TipoDestino, [varios: string, uno: string]> = {
	maquina: ['machines', 'a machine'],
	fileserver: ['file servers', 'a file server'],
	web: ['websites', 'a website'],
	'paas-web': ['PaaS web apps', 'a PaaS web app'],
	hosting: ['hosting accounts', 'a hosting account'],
	dominio: ['Active Directory domains', 'an Active Directory domain'],
	tenant: ['cloud tenants', 'a cloud tenant'],
	saas: ['SaaS services', 'a SaaS service'],
	otro: ['other targets', 'another type of target']
};

/* «del registro {canal} de fs01». */
const CANALES: Record<string, string> = {
	'windows-eventos': 'Windows event logs',
	syslog: 'syslog',
	journald: 'the journald journal',
	'directorio-activo': 'Active Directory logs'
};

const CONEXIONES: Record<string, string> = {
	graph: 'Microsoft 365',
	azure: 'Azure',
	aws: 'AWS',
	google: 'Google',
	ldap: 'the LDAP directory'
};

const nombreDe = (tabla: Record<string, string>, clave: string) =>
	Object.hasOwn(tabla, clave) ? tabla[clave] : clave;

const tipoTexto = (t: string, n: 0 | 1) =>
	Object.hasOwn(TIPOS, t) ? TIPOS[t as TipoDestino][n] : t;

/* «a», «a o b», «a, b o c». */
function unaLista(xs: string[], y: string): string {
	return xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${y} ${xs.at(-1)}`;
}

/* El valor de un hecho, o undefined si no está (un valor null cuenta como que no está). */
function valorDe(hechos: Hechos, clave: string): unknown {
	if (!Object.hasOwn(hechos, clave)) return undefined;
	const h: unknown = hechos[clave];
	return typeof h === 'object' && h !== null
		? ((h as { valor?: unknown }).valor ?? undefined)
		: undefined;
}

/* Una copia que la salida puede llevar sin compartir nada con la entrada. */
const copia = <T>(x: T): T => (x === undefined ? x : structuredClone(x));

const sinPunto = (t: string) => t.replace(/\.$/, '');
const frase = (t: string) => (/[.!?…]$/.test(t) ? t : `${t}.`);

/*
 * Cómo se sabría un hecho que no está, según quién lo da (§4.2): lo que viene
 * del formulario lo puede decir el cliente; lo del sensor, solo un sensor.
 */
function comoSaberlo(hecho: string, d: Destino): string {
	const fuentes = Object.hasOwn(HECHOS, hecho) ? HECHOS[hecho].fuentes : [];
	if (fuentes.includes('formulario')) return `enter it on the ${d.nombre} page, in Targets`;
	if (fuentes.includes('sensor'))
		return d.agente
			? `the sensor on ${d.nombre} will report it once it updates`
			: `a sensor installed on ${d.nombre} provides it`;
	return 'this console does not know it yet';
}

/* §3.2: el requisito no se cumple o falta su hecho. */
function motivoDeRequisito(r: Requisito, hechos: Hechos, d: Destino, falta: boolean): Motivo {
	const ops = OPERADORES.filter((o) => Object.hasOwn(r, o));
	const esperado = Object.fromEntries(ops.map((o) => [o, (r as Record<string, unknown>)[o]]));
	const valor = valorDe(hechos, r.hecho);
	const extra = {
		hecho: r.hecho,
		esperado: copia(esperado),
		...(valor === undefined ? {} : { valor: copia(valor) })
	};
	/* Con el nombre del hecho para el cliente, no su clave (que va en motivo.hecho). */
	const nombre = nombreHecho(r.hecho);
	if (falta)
		return motivo(
			'requisito.sin-dato',
			{ motivo: frase(r.motivo), hecho: nombre, comoSaberlo: comoSaberlo(r.hecho, d) },
			extra
		);
	const detalle = `${nombre}: ${valor === undefined ? 'unknown' : valorVisible(r.hecho, valor)}`;
	return motivo(
		'requisito.no-cumple',
		{ motivo: sinPunto(r.motivo), detalle },
		{ ...extra, ...(r.remedio === undefined ? {} : { remedio: r.remedio }) }
	);
}

/* Remedio de agente.falta según plataforma.so (§7.2). */
function remedioAgenteFalta(so: unknown, destino: string): string {
	switch (so) {
		case 'linux':
			return `Install a sensor on ${destino}: in Sensors, use "Install a sensor on another machine".`;
		case 'windows':
			return `On Windows, the sensor runs in the appliance: import it into Hyper-V or VMware, with bridged networking, on the network of ${destino}.`;
		case 'macos':
			return 'macOS needs the native agent, which will arrive later.';
		default:
			return `Install a sensor on ${destino} (in Sensors, use "Install a sensor on another machine") or put the Hyper-V or VMware appliance on its network.`;
	}
}

const SEMVER = /^\d+\.\d+\.\d+$/;

/* Como hoy en plan(): «dev» siempre basta; una versión desconocida o que no es x.y.z, nunca. */
function versionBasta(version: unknown, minimo: string): boolean {
	if (version === 'dev') return true;
	if (typeof version !== 'string' || !SEMVER.test(version)) return false;
	const r: Requisito = { hecho: 'agente.version', minimo, motivo: '' };
	return evaluarRequisito(r, { 'agente.version': { valor: version } }) === 'cumple';
}

/* §7.2, paso 2.4: el agente del destino puede correr la vía. */
function delAgente(v: Via, d: Destino, hechos: Hechos, motivos: Motivo[], avisos: Motivo[]) {
	if (!d.agente) {
		motivos.push(
			motivo(
				'agente.falta',
				{ destino: d.nombre },
				{ remedio: remedioAgenteFalta(valorDe(hechos, 'plataforma.so'), d.nombre) }
			)
		);
		return;
	}
	const ejecutores = valorDe(hechos, 'agente.ejecutores');
	if (!Array.isArray(ejecutores) || !ejecutores.includes(v.ejecutor))
		motivos.push(
			motivo(
				'agente.sin-ejecutor',
				{ destino: d.nombre },
				ejecutores === undefined ? {} : { valor: copia(ejecutores) }
			)
		);
	else {
		/*
		 * Un sensor que no dice qué ejecuta: lo pone la consola por él
		 * (hechosDeConsola). Solo se avisa si además no dice nada de su máquina
		 * (0.12 y 0.13): de un 0.13.1 se sabe su motor, y avisar en cada trampa
		 * de algo que no es verdad enseña a ignorar los avisos.
		 */
		const h = hechos['agente.ejecutores'];
		const deConsola = h.fuente === 'consola' || h.motivo === 'agente.anterior';
		const informa = Object.values(d.hechos).some((x) => x?.fuente === 'sensor');
		if (deConsola && !informa) avisos.push(motivo('agente.anterior'));
	}
	if (v.sensorMinimo !== undefined) {
		const version = d.agente.version ?? valorDe(hechos, 'agente.version');
		if (!versionBasta(version, v.sensorMinimo))
			motivos.push(
				motivo(
					'agente.version',
					{ minimo: v.sensorMinimo },
					{ esperado: v.sensorMinimo, ...(version === undefined ? {} : { valor: copia(version) }) }
				)
			);
	}
	if (!d.agente.vivo) avisos.push(motivo('agente.sin-contacto', { destino: d.nombre }));
}

/* El texto de una marca, o undefined si no tiene la forma del contrato (llega de la base de datos). */
function valorMarca(m: unknown): string | undefined {
	if (typeof m !== 'object' || m === null) return undefined;
	const v = Object.hasOwn(m, 'igual')
		? (m as { igual: unknown }).igual
		: (m as { contiene?: unknown }).contiene;
	return typeof v === 'string' ? v : undefined;
}

/*
 * Dos marcas se solapan si un mismo evento podría cumplir las dos: dos igual
 * con el mismo valor, o un contiene que cabe en el otro. Sin distinguir
 * mayúsculas (§2.4).
 */
function solapan(a: Marca, b: Marca): boolean {
	const va = valorMarca(a)?.toLowerCase();
	const vb = valorMarca(b)?.toLowerCase();
	if (va === undefined || vb === undefined || a.campo !== b.campo) return false;
	const ia = Object.hasOwn(a, 'igual');
	const ib = Object.hasOwn(b, 'igual');
	if (ia && ib) return va === vb;
	if (ia) return va.includes(vb);
	if (ib) return vb.includes(va);
	return va.includes(vb) || vb.includes(va);
}

/*
 * La marca de la vía con los valores reales. Los huecos que el elector no
 * conoce (trampa.id, trampa.nombre, los parámetros de la trampa objetivo)
 * dejan la marca sin resolver: undefined, y no se compara.
 */
function resolverMarca(
	m: Marca,
	p: Record<string, unknown>,
	d: Destino,
	hechos: Hechos,
	c: ContextoElector
): Marca | undefined {
	const plantilla = valorMarca(m);
	if (plantilla === undefined) return undefined;
	let suelto = false;
	const valor = plantilla.replace(/\$\{([^}]*)\}/g, (_, nombre: string) => {
		const simple = (v: unknown) =>
			typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
				? String(v)
				: undefined;
		let r: string | undefined;
		if (Object.hasOwn(p, nombre)) r = simple(p[nombre]);
		else if (nombre === 'destino.nombre') r = d.nombre;
		else if (nombre === 'destino.direccion') r = simple(valorDe(hechos, 'destino.direccion'));
		else if (nombre.endsWith('.direccion')) {
			const id = p[nombre.slice(0, -'.direccion'.length)];
			if (typeof id === 'string' && Object.hasOwn(c.trampas, id)) r = c.trampas[id].direccion;
		}
		if (r === undefined) suelto = true;
		return r ?? '';
	});
	if (suelto) return undefined;
	return Object.hasOwn(m, 'igual')
		? { campo: m.campo, igual: valor }
		: { campo: m.campo, contiene: valor };
}

/* §2.4, fuente «trampa»: el parámetro x-trampa apunta a una trampa que recibe y tiene dirección. */
function senalPorTrampa(
	h: Honeycosa,
	fuente: Extract<Fuente, { tipo: 'trampa' }>,
	p: Record<string, unknown>,
	d: Destino,
	hechos: Hechos,
	c: ContextoElector,
	modo: Modo
): Motivo[] {
	const param = fuente.trampa.replace(/^\$\{(.*)\}$/, '$1');
	const def: unknown = Object.hasOwn(h.parametros.properties, param)
		? h.parametros.properties[param]
		: undefined;
	const x = (def as { 'x-trampa'?: { modulos?: unknown } } | undefined)?.['x-trampa'];
	const modulos = Array.isArray(x?.modulos)
		? x.modulos.filter((m): m is string => typeof m === 'string')
		: [];
	/* Con el nombre de cada módulo, si la consola lo pasa; si no, su id. */
	const nombres = modulos.map((m) => {
		const n = c.nombresModulos && Object.hasOwn(c.nombresModulos, m) ? c.nombresModulos[m] : m;
		return `"${n}"`;
	});
	const sinObjetivo = () => motivo('senal.trampa-objetivo', { modulos: unaLista(nombres, 'or') });
	const sinDireccion = (t: TrampaDelCliente) =>
		motivo('senal.objetivo-sin-direccion', { objetivo: t.nombre, destino: t.destinoNombre });
	const recibe = (t: TrampaDelCliente) =>
		modulos.includes(t.modulo) && RECIBEN.includes(t.colocacion);
	const elegido = p[param];
	if (typeof elegido !== 'string' || elegido === '') {
		/* Sondeo: vale si alguna trampa del cliente cumple el alcance. Al guardar, falta. */
		if (modo === 'reales') return [sinObjetivo()];
		const candidatas = Object.values(c.trampas).filter(recibe);
		if (!candidatas.length) return [sinObjetivo()];
		return candidatas.some((t) => t.direccion) ? [] : [sinDireccion(candidatas[0])];
	}
	const t = Object.hasOwn(c.trampas, elegido) ? c.trampas[elegido] : undefined;
	if (!t || !recibe(t)) return [sinObjetivo()];
	if (!t.direccion) return [sinDireccion(t)];
	if (modo === 'sondeo') return [];
	/* Cada evento activa como mucho una trampa: la marca no se solapa con otra del mismo objetivo. */
	const nuestra = resolverMarca(fuente.marca, p, d, hechos, c);
	const otra = nuestra && t.marcas.find((o) => solapan(nuestra, o.marca));
	return otra
		? [
				motivo(
					'senal.marca-repetida',
					{ otra: otra.nombre, valor: valorMarca(otra.marca) ?? '', objetivo: t.nombre },
					{ valor: valorMarca(nuestra) }
				)
			]
		: [];
}

/* §7.2, paso 2.6: la fuente es de las del ejecutor y su señal puede volver (§2.4). */
function senal(
	h: Honeycosa,
	v: Via,
	ej: Ejecutor,
	p: Record<string, unknown>,
	d: Destino,
	hechos: Hechos,
	c: ContextoElector,
	modo: Modo
): Motivo[] {
	const fuente = v.senal?.fuente;
	if (!fuente || !ej.fuentes.includes(fuente.tipo)) return [motivo('senal.inalcanzable')];
	const cumple = (r: Requisito) => evaluarRequisito(r, hechos) === 'cumple';
	switch (fuente.tipo) {
		case 'fichero':
			/* Lo lee el agente del destino; si no hay agente, ya lo dice agente.falta. */
			return ej.corre === 'agente' ? [] : [motivo('senal.inalcanzable')];
		case 'trampa':
			return senalPorTrampa(h, fuente, p, d, hechos, c, modo);
		case 'registros':
			return cumple({ hecho: 'recolector.canales', contiene: fuente.canal, motivo: '' })
				? []
				: [
						motivo('senal.sin-recolector', {
							canal: nombreDe(CANALES, fuente.canal),
							destino: d.nombre
						})
					];
		case 'rele':
			return cumple({ hecho: 'canal.rele', igual: true, motivo: '' })
				? []
				: [motivo('senal.sin-rele')];
		case 'conector':
			return cumple({ hecho: `conexion.${fuente.conexion}.estado`, igual: 'activa', motivo: '' })
				? []
				: [motivo('senal.sin-conexion', { conexion: nombreDe(CONEXIONES, fuente.conexion) })];
		default:
			return [motivo('senal.inalcanzable')];
	}
}

/* Sin repetir el mismo texto con el mismo código (tcp y udp del mismo puerto contra la misma trampa). */
function unicos(ms: Motivo[]): Motivo[] {
	const vistos = new Set<string>();
	return ms.filter((m) => {
		const k = `${m.codigo}\n${m.texto}`;
		if (vistos.has(k)) return false;
		vistos.add(k);
		return true;
	});
}

function evaluarVia(
	h: Honeycosa,
	v: Via,
	d: Destino,
	hechos: Hechos,
	c: ContextoElector,
	p: Record<string, unknown>,
	modo: Modo
): ViaEvaluada {
	const ej =
		Object.hasOwn(EJECUTORES, v.ejecutor) && c.ejecutoresConsola.includes(v.ejecutor)
			? EJECUTORES[v.ejecutor]
			: undefined;
	const motivos: Motivo[] = [];
	const avisos: Motivo[] = [];
	const evaluada = (): ViaEvaluada => ({
		via: v.id,
		ejecutor: v.ejecutor,
		nombre: v.nombre ?? ej?.nombre ?? v.ejecutor,
		clase: ej?.clase ?? null,
		motivos: unicos(motivos),
		avisos: unicos(avisos)
	});
	/* Las tres primeras son estructurales: paran la evaluación de esta vía. */
	if (!ej) {
		motivos.push(motivo('ejecutor.desconocido', { ejecutor: v.ejecutor }));
		return evaluada();
	}
	if (!d.activo) {
		motivos.push(motivo('destino.inactivo', { destino: d.nombre }));
		return evaluada();
	}
	const tipos = v.destino ?? ej.destinos;
	if (!tipos.includes(d.tipo)) {
		motivos.push(
			motivo(
				'destino.tipo',
				{
					tipos: unaLista(
						tipos.map((t) => tipoTexto(t, 0)),
						'or'
					),
					destino: d.nombre,
					tipo: tipoTexto(d.tipo, 1)
				},
				{ esperado: [...tipos], valor: d.tipo }
			)
		);
		return evaluada();
	}
	/* El resto se acumula, para enseñar todos los motivos a la vez. */
	if (ej.corre === 'agente') delAgente(v, d, hechos, motivos, avisos);
	for (const r of [...ej.requisitos, ...(v.requisitos ?? [])]) {
		const resultado = evaluarRequisito(r, hechos);
		const efecto = efectoRequisito(r, resultado);
		if (efecto === 'nada') continue;
		const m = motivoDeRequisito(r, hechos, d, resultado === 'sin-dato');
		(efecto === 'descarta' ? motivos : avisos).push(m);
	}
	motivos.push(...senal(h, v, ej, p, d, hechos, c, modo));
	if (ej.comprobar) {
		const r = ej.comprobar(v, p, d, c);
		/* Sondeo: con el puerto por defecto choca, pero con otro la vía valdría. */
		const aviso = (m: Motivo) => modo === 'sondeo' && m.codigo.startsWith('puertos.');
		motivos.push(...r.motivos.filter((m) => !aviso(m)));
		avisos.push(...r.avisos, ...r.motivos.filter(aviso));
	}
	return evaluada();
}

const vacio = (v: unknown) => v === undefined || v === null || v === '';

/* Sondeo: lo que pase el cliente, completado con los default del esquema. */
function conDefectos(
	esquema: EsquemaParametros,
	valor: Record<string, unknown> | undefined
): Record<string, unknown> {
	const p: Record<string, unknown> = {};
	for (const [k, def] of Object.entries(esquema.properties))
		if (typeof def === 'object' && def !== null && Object.hasOwn(def, 'default'))
			p[k] = copia((def as { default: unknown }).default);
	for (const [k, v] of Object.entries(valor ?? {})) if (!vacio(v)) p[k] = copia(v);
	return p;
}

export function elegir(e: EntradaElector): Eleccion {
	const { honeycosa: h, destino: d, parametros, contexto: c } = e;
	const global = (g: Motivo): Eleccion => ({
		elegida: null,
		validas: [],
		descartadas: [],
		global: g
	});
	/* 1. Globales: se para en el primero. */
	if (!c.autorizado) return global(motivo('modulo.no-autorizado', { nombre: h.nombre }));
	if (!h.vias.length) return global(motivo('modulo.sin-vias'));
	if (parametros.modo === 'reales' && !parametros.valor.ok)
		return global(
			motivo(
				'parametros.invalidos',
				{ errores: parametros.valor.errores.join('; ') },
				{ valor: [...parametros.valor.errores] }
			)
		);
	const p =
		parametros.modo === 'reales'
			? (parametros.valor as { ok: true; valor: Record<string, unknown> }).valor
			: conDefectos(h.parametros, parametros.valor);
	/* Los del destino ganan a los del nodo. */
	const hechos: Hechos = { ...c.hechosNodo, ...d.hechos };

	/* 2. Cada vía, en el orden del manifiesto. */
	const evaluadas = h.vias.map((v) => evaluarVia(h, v, d, hechos, c, p, parametros.modo));
	const descartadas = evaluadas.filter((v) => v.motivos.length);

	/* 3. Preferencia: la del cliente si vale; si no, agente, conector, manual; sin avisos; manifiesto. */
	const preferida = c.preferida === undefined ? undefined : viaDe(h, c.preferida)?.id;
	const orden = new Map(h.vias.map((v, i) => [v.id, i]));
	const clase = (v: ViaEvaluada) => (v.clase === null ? 3 : ORDEN_CLASE[v.clase]);
	const validas = evaluadas
		.filter((v) => !v.motivos.length)
		.sort(
			(a, b) =>
				Number(b.via === preferida) - Number(a.via === preferida) ||
				clase(a) - clase(b) ||
				Number(a.avisos.length > 0) - Number(b.avisos.length > 0) ||
				orden.get(a.via)! - orden.get(b.via)!
		);

	/* 4. Ninguna. */
	return {
		elegida: validas[0] ?? null,
		validas,
		descartadas,
		global: validas.length
			? null
			: motivo('elector.sin-via', { nombre: h.nombre, destino: d.nombre })
	};
}
