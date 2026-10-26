import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import esquemaEvento from './esquemas/evento.schema.json' with { type: 'json' };
import esquemaTrampa from './esquemas/trampa.schema.json' with { type: 'json' };
import esquemaRespuesta from './esquemas/respuesta.schema.json' with { type: 'json' };
import esquemaTrampaV2 from './esquemas/trampa-v2.schema.json' with { type: 'json' };
import { normalizar } from './honeycosa.ts';
import type {
	CargaContenedor,
	CargaManual,
	EsquemaParametros,
	Evento,
	Honeycosa,
	ManifiestoRespuesta,
	ManifiestoTrampa,
	ManifiestoTrampaV2,
	Marca,
	Paso,
	Traductor,
	Via
} from './tipos.ts';

export type Resultado<T> = { ok: true; valor: T } | { ok: false; errores: string[] };

// strictRequired avisa en falso con if/then: el campo exigido sí está definido, pero en properties de la raíz.
const ajv = new Ajv2020({
	allErrors: true,
	strict: true,
	strictRequired: false,
	allowUnionTypes: true
});
addFormats.default(ajv);
ajv.addSchema([esquemaEvento, esquemaTrampa, esquemaRespuesta, esquemaTrampaV2]);

const comprobar = {
	evento: ajv.getSchema(esquemaEvento.$id)!,
	trampa: ajv.getSchema(esquemaTrampa.$id)!,
	respuesta: ajv.getSchema(esquemaRespuesta.$id)!,
	trampaV2: ajv.getSchema(esquemaTrampaV2.$id)!
};

function errores(validador: (typeof comprobar)[keyof typeof comprobar]): string[] {
	return (validador.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/* ${nombre} dentro de un texto: un hueco que se rellena con un parámetro del formulario. */
function huecos(texto: string): string[] {
	return [...texto.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
}

function huecosSinParametro(textos: string[], parametros: Record<string, unknown>): string[] {
	return textos
		.flatMap(huecos)
		.filter((h) => !Object.hasOwn(parametros, h))
		.map((h) => `\${${h}} no es un parámetro declarado`);
}

/*
 * Los manifiestos se leen como YAML plano: sin etiquetas propias ni anclas que
 * se expandan, para que un módulo no pueda colar nada que no sea datos.
 */
function leerYaml(texto: string): Resultado<unknown> {
	try {
		return {
			ok: true,
			valor: parse(texto, { customTags: [], maxAliasCount: 0, uniqueKeys: true })
		};
	} catch (e) {
		return { ok: false, errores: [`YAML ilegible: ${(e as Error).message}`] };
	}
}

export function validarEvento(dato: unknown): Resultado<Evento> {
	if (!comprobar.evento(dato)) return { ok: false, errores: errores(comprobar.evento) };
	const { senuelo, ...e } = dato as Evento & { senuelo?: Evento['trampa'] };
	/* Un evento de la versión 1 se lee igual que uno de la 2; sus bytes, los que encadenan, no se tocan. */
	return { ok: true, valor: senuelo ? { ...e, trampa: senuelo } : e };
}

type Contenedor = NonNullable<ManifiestoTrampa['contenedor']>;

/*
 * Dentro del contenedor, 1024 o más. El sensor la arranca sin capacidades
 * y con el usuario de la imagen; un puerto por debajo de 1024 solo se
 * abre sin privilegios donde el kernel lo permite (Docker en Linux 4.11 o
 * posterior), no en CentOS/RHEL 7 ni, según cómo, en Podman: la trampa se
 * reiniciaría sin fin. Lo que ve el atacante es «expuesto», que sí puede
 * ser el 53 o el 445.
 */
function puertosBajos(c: Contenedor | undefined): string[] {
	return (c?.puertos ?? [])
		.filter((p) => p.interno < 1024)
		.map(
			(p) =>
				`contenedor.puertos: el interno ${p.interno}/${p.protocolo} tiene que ser 1024 o más (dentro del contenedor la trampa corre sin privilegios); el puerto que ve el atacante es «expuesto»`
		);
}

function fallosDeTraductor(ev: Traductor): string[] {
	return ev.contrasena && !ev.detalle?.includes(ev.contrasena)
		? [`contrasena: ${ev.contrasena} tiene que estar en detalle`]
		: [];
}

/* Todo lo que nombra un parámetro tiene que nombrar uno que exista. */
function parametrosDeContenedor(c: Contenedor | undefined, props: Record<string, unknown>) {
	const textos = [
		...Object.values(c?.entorno ?? {}).map((v) => (typeof v === 'string' ? v : '')),
		...(c?.ficheros ?? []).map((f) => f.contenido),
		...(c?.puertos ?? []).map((p) => (typeof p.expuesto === 'string' ? p.expuesto : ''))
	];
	const nombrados = [
		...Object.values(c?.entorno ?? {}).flatMap((v) => (typeof v === 'string' ? [] : [v.segun])),
		...(c?.puertos ?? []).flatMap((p) => (p.si ? [p.si] : []))
	];
	return [
		...huecosSinParametro(textos, props),
		...nombrados
			.filter((n) => !Object.hasOwn(props, n))
			.map((n) => `${n} no es un parámetro declarado`)
	];
}

export function validarTrampa(dato: unknown): Resultado<ManifiestoTrampa> {
	if (!comprobar.trampa(dato)) return { ok: false, errores: errores(comprobar.trampa) };
	const m = dato as ManifiestoTrampa;
	const fallos = [
		...puertosBajos(m.contenedor),
		...fallosDeTraductor(m.eventos),
		...parametrosDeContenedor(m.contenedor, m.parametros.properties)
	];
	return fallos.length ? { ok: false, errores: fallos } : { ok: true, valor: m };
}

export function validarRespuesta(dato: unknown): Resultado<ManifiestoRespuesta> {
	if (!comprobar.respuesta(dato)) return { ok: false, errores: errores(comprobar.respuesta) };
	const m = dato as ManifiestoRespuesta;
	const fallos = huecosSinParametro(m.salida, m.parametros.properties);
	return fallos.length ? { ok: false, errores: fallos } : { ok: true, valor: m };
}

export function leerTrampa(yaml: string): Resultado<ManifiestoTrampa> {
	const r = leerYaml(yaml);
	return r.ok ? validarTrampa(r.valor) : r;
}

/*
 * Manifiesto v2 (docs/diseno/modulo-despliegue.md §2.3). El esquema dice la
 * forma; aquí van las reglas que no caben en él (las numera el diseño).
 */

type DefParametro = Record<string, unknown>;
type XAleatorio = { bases: string[]; sufijo: number; alfabeto?: keyof typeof ALFABETOS };

const ALFABETOS = {
	'minusculas-digitos': 'abcdefghijklmnopqrstuvwxyz0123456789',
	digitos: '0123456789'
};

/*
 * Variables de contexto: las pone la consola y llegan ya validadas (§6.3). En
 * las órdenes van con _ en lugar de punto ($sd.destino_direccion,
 * SD_DESTINO_DIRECCION). Además, ${<x-trampa>.direccion} y
 * ${<x-trampa>.<parametro>}, y ${nonce} solo en comprobacion.prueba.
 *
 * Además ${baliza_url}: la URL de la baliza de esta honeycosa (§2.5), para
 * las de nube que la pegan en un webhook o en un píxel (H28–H31); la acuña
 * la consola al darle de alta, así que solo la llevan esas vías.
 */
const CONTEXTO = [
	'trampa.id',
	'trampa.nombre',
	'destino.nombre',
	'destino.direccion',
	'baliza_url'
] as const;
type Contexto = (typeof CONTEXTO)[number];
const CONTEXTO_PS = CONTEXTO.map((c) => c.replace('.', '_'));
const CONTEXTO_SH = CONTEXTO_PS.map((c) => c.toUpperCase());

/*
 * Un parámetro que acaba en una orden es numérico o tiene sus valores
 * cerrados: un enum o un pattern anclado de principio a fin. El valor entra
 * como literal escapado en el bloque de variables; así, además, no puede
 * llevar nada que no sea lo esperado.
 */
function seguroEnOrden(def: DefParametro | undefined): boolean {
	if (!def) return false;
	if (def.type === 'integer' || def.type === 'number' || Array.isArray(def.enum)) return true;
	return (
		typeof def.pattern === 'string' && def.pattern.startsWith('^') && def.pattern.endsWith('$')
	);
}

/* Un nombre usado en una vía: en un texto (${…}) o en una orden ($sd.x en PowerShell, SD_X en sh). */
type Uso = { forma: 'texto' | 'ps' | 'sh'; nombre: string; prueba: boolean; donde: string };

/*
 * A qué se refiere un nombre usado en una vía (reglas 5 y 6): un parámetro
 * del módulo, una variable de contexto, la dirección del destino de la trampa
 * objetivo o uno de sus parámetros, o el nonce de la prueba. En sh el campo de
 * un objetivo llega en mayúsculas (exacto: false): cómo se escribe solo lo
 * saben el catálogo y la propia trampa objetivo.
 */
export type VariableDeVia =
	| { de: 'parametro'; parametro: string }
	| { de: 'contexto'; nombre: Contexto }
	| { de: 'objetivo-direccion'; parametro: string }
	| { de: 'objetivo'; parametro: string; campo: string; exacto: boolean }
	| { de: 'nonce' };

export type UsoDeVia = Uso & { variable: VariableDeVia };

const comoSeEscribe = (u: Uso) =>
	u.forma === 'texto' ? `\${${u.nombre}}` : u.forma === 'ps' ? `$sd.${u.nombre}` : `SD_${u.nombre}`;

function usosDe(v: Via): { usos: Uso[]; fallos: string[] } {
	const lenguaje = v.ejecutor === 'manual@1' ? (v.carga as CargaManual).lenguaje : undefined;
	const usos: Uso[] = [];
	const fallos: string[] = [];
	const texto = (t: string, donde: string, prueba: boolean) => {
		for (const nombre of huecos(t)) usos.push({ forma: 'texto', nombre, prueba, donde });
	};
	/* Sin lenguaje (la prueba de una vía contenedor@1), valen las dos formas. */
	const codigo = (t: string, donde: string, prueba: boolean) => {
		if (t.includes('${'))
			fallos.push(
				`${donde}: es código y no admite \${…}; usa el bloque de variables ($sd.<clave> o SD_<CLAVE>)`
			);
		if (lenguaje !== 'sh') {
			for (const m of t.matchAll(/\$sd\.([A-Za-z_][A-Za-z0-9_]*)/gi))
				usos.push({ forma: 'ps', nombre: m[1], prueba, donde });
			if (/\$sd(?![A-Za-z0-9_]|\.[A-Za-z_])/i.test(t))
				fallos.push(`${donde}: $sd solo se usa como $sd.<clave>`);
		}
		if (lenguaje !== 'powershell')
			for (const m of t.matchAll(/(?<![A-Za-z0-9_])SD_([A-Za-z0-9_]+)/g))
				usos.push({ forma: 'sh', nombre: m[1], prueba, donde });
	};
	const pasos = (lista: Paso[] | undefined, donde: string, prueba: boolean) =>
		lista?.forEach((p, n) => {
			texto(p.texto, `${donde}[${n}].texto`, prueba);
			if (p.orden !== undefined) codigo(p.orden, `${donde}[${n}].orden`, prueba);
			if (p.comprobar !== undefined) codigo(p.comprobar, `${donde}[${n}].comprobar`, prueba);
		});
	const marca = (m: Marca | undefined, donde: string, prueba: boolean) => {
		if (m) texto('igual' in m ? m.igual : m.contiene, donde, prueba);
	};
	if (v.ejecutor === 'manual@1') pasos((v.carga as CargaManual).pasos, 'carga.pasos', false);
	if (v.retirada.tipo === 'manual') pasos(v.retirada.pasos, 'retirada.pasos', false);
	const fuente = v.senal?.fuente;
	if (fuente?.tipo === 'trampa') marca(fuente.marca, 'senal.fuente.marca', false);
	pasos(v.comprobacion?.prueba?.pasos, 'comprobacion.prueba.pasos', true);
	marca(v.comprobacion?.prueba?.marca, 'comprobacion.prueba.marca', true);
	return { usos, fallos };
}

/*
 * Reglas 5 y 6: a qué se refiere un nombre. Un parámetro de otro módulo solo
 * se puede comprobar con el catálogo (validarCatalogo) o con la trampa a la
 * que apunta (renderizar, en manual.ts).
 */
function resolver(
	u: Uso,
	props: Record<string, DefParametro>,
	xTrampa: Set<string>
): { fallo: string } | { variable: VariableDeVia } {
	const donde = `${u.donde}: ${comoSeEscribe(u)}`;
	const noDeclarado = {
		fallo: `${donde} no es un parámetro declarado ni una variable de contexto`
	};
	const parametro = (p: string) => ({ variable: { de: 'parametro', parametro: p } as const });
	const contexto = (nombre: Contexto) => ({ variable: { de: 'contexto', nombre } as const });
	const deObjetivo = (param: string, campo: string, exacto: boolean) => {
		if (!xTrampa.has(param))
			return Object.hasOwn(props, param)
				? { fallo: `${donde}: ${param} no es un parámetro con x-trampa` }
				: noDeclarado;
		return campo === (exacto ? 'direccion' : 'DIRECCION')
			? { variable: { de: 'objetivo-direccion', parametro: param } as const }
			: { variable: { de: 'objetivo', parametro: param, campo, exacto } as const };
	};
	const nonce = u.prueba
		? { variable: { de: 'nonce' } as const }
		: { fallo: `${donde} solo vale en comprobacion.prueba` };
	if (u.forma === 'texto') {
		if (Object.hasOwn(props, u.nombre)) return parametro(u.nombre);
		const c = CONTEXTO.find((x) => x === u.nombre);
		if (c) return contexto(c);
		if (u.nombre === 'nonce') return nonce;
		const i = u.nombre.indexOf('.');
		return i > 0 ? deObjetivo(u.nombre.slice(0, i), u.nombre.slice(i + 1), true) : noDeclarado;
	}
	/* En sh los nombres van en mayúsculas: SD_OBJETIVO_PUERTOSSH es objetivo_puertoSsh. */
	const param =
		u.forma === 'ps'
			? Object.hasOwn(props, u.nombre)
				? u.nombre
				: undefined
			: Object.keys(props).find((p) => p.toUpperCase() === u.nombre);
	if (param !== undefined)
		return seguroEnOrden(props[param])
			? parametro(param)
			: {
					fallo: `${donde}: el parámetro ${param} va en una orden y no es numérico ni declara un enum o un pattern anclado (^…$)`
				};
	if (u.forma === 'ps') {
		const i = CONTEXTO_PS.indexOf(u.nombre);
		if (i >= 0) return contexto(CONTEXTO[i]);
		if (u.nombre === 'nonce') return nonce;
		const j = u.nombre.indexOf('_');
		return j > 0 ? deObjetivo(u.nombre.slice(0, j), u.nombre.slice(j + 1), true) : noDeclarado;
	}
	const i = CONTEXTO_SH.indexOf(u.nombre);
	if (i >= 0) return contexto(CONTEXTO[i]);
	if (u.nombre === 'NONCE') return nonce;
	const x = [...xTrampa].find((p) => u.nombre.startsWith(`${p.toUpperCase()}_`));
	return x ? deObjetivo(x, u.nombre.slice(x.length + 1), false) : noDeclarado;
}

/*
 * Los parámetros de texto con x-trampa: los que pueden apuntar a otra trampa
 * (regla 7). En un v2 el esquema garantiza su forma; se mira igual, porque el
 * esquema de v1 no mira los parámetros por dentro y un x-trampa: true no
 * puede hacer lanzar a nadie.
 */
function conXTrampa(props: Record<string, DefParametro>): Set<string> {
	return new Set(
		Object.keys(props).filter((p) => {
			const def = props[p];
			const x = typeof def === 'object' && def !== null ? def['x-trampa'] : undefined;
			return (
				def?.type === 'string' &&
				typeof x === 'object' &&
				x !== null &&
				Array.isArray((x as { modulos?: unknown }).modulos)
			);
		})
	);
}

/*
 * Las variables que usa una vía (§6.3), en el orden en que salen en sus pasos
 * de colocar, de retirar y de prueba y en sus marcas: es lo que lleva el
 * bloque de variables de los pasos generados (manual.ts). Una referencia que
 * no se resuelve sale en fallos, con el mismo texto que en validarHoneycosa.
 */
export function variablesDeVia(
	v: Via,
	esquema: EsquemaParametros
): { usos: UsoDeVia[]; fallos: string[] } {
	const props = esquema.properties as Record<string, DefParametro>;
	const xTrampa = conXTrampa(props);
	const { usos, fallos } = usosDe(v);
	const resueltos: UsoDeVia[] = [];
	for (const u of usos) {
		const r = resolver(u, props, xTrampa);
		if ('fallo' in r) fallos.push(r.fallo);
		else resueltos.push({ ...u, variable: r.variable });
	}
	return { usos: resueltos, fallos };
}

/*
 * Regla 8: cada base con un sufijo de «sufijo» caracteres cumple el esquema
 * del parámetro, sea cual sea el carácter del alfabeto (se prueba con cada uno).
 */
function aleatoriosQueNoCumplen(nombre: string, cumple: Validador, xa: XAleatorio): string[] {
	const alfabeto = [...ALFABETOS[xa.alfabeto ?? 'minusculas-digitos']];
	return xa.bases.flatMap((base) => {
		const malo = alfabeto.map((c) => base + c.repeat(xa.sufijo)).find((v) => !cumple(v));
		return malo === undefined
			? []
			: [
					`parametros.${nombre}: x-aleatorio: la base ${base} con ${xa.sufijo} caracteres al azar no cumple el parámetro (p. ej. ${malo})`
				];
	});
}

function parametrosV2(props: Record<string, DefParametro>) {
	const xTrampa = new Set<string>();
	const fallos: string[] = [];
	for (const [nombre, def] of Object.entries(props)) {
		/* Regla 7. */
		if (def['x-trampa'] !== undefined) {
			if (def.type === 'string') xTrampa.add(nombre);
			else fallos.push(`parametros.${nombre}: x-trampa solo vale en un parámetro type: string`);
		}
		/*
		 * Un esquema que no compila (un pattern mal escrito, una palabra con un
		 * valor que no vale) es un error más: un manifiesto que pasa la lectura no
		 * puede hacer lanzar a validarParametros al dar de alta, ni a la regla 8.
		 */
		const cumple = compilarEsquema(def);
		if (typeof cumple !== 'function') {
			fallos.push(`parametros.${nombre}: el esquema no compila: ${cumple.error}`);
			continue;
		}
		/* Regla 8. */
		const xa = def['x-aleatorio'] as XAleatorio | undefined;
		if (xa === undefined) continue;
		if (def.type !== 'string')
			fallos.push(`parametros.${nombre}: x-aleatorio solo vale en un parámetro type: string`);
		else if (Object.hasOwn(def, 'default'))
			fallos.push(
				`parametros.${nombre}: x-aleatorio no admite default (la consola propone un valor distinto en cada trampa)`
			);
		else fallos.push(...aleatoriosQueNoCumplen(nombre, cumple, xa));
	}
	return { xTrampa, fallos };
}

function reglasDeVia(
	m: ManifiestoTrampaV2,
	v: Via,
	props: Record<string, DefParametro>,
	xTrampa: Set<string>
): string[] {
	const fallos: string[] = [];
	const fuente = v.senal?.fuente;
	/* Regla 2. */
	if (!fuente) fallos.push('una vía necesita señal (senal.fuente)');
	else if (
		(fuente.tipo === 'fichero' || fuente.tipo === 'registros') &&
		!(v.senal.eventos ?? m.senal.eventos)
	)
		fallos.push(
			`la fuente ${fuente.tipo} necesita un traductor (senal.eventos en la vía o en la raíz)`
		);
	/* Regla 7. */
	if (fuente?.tipo === 'trampa' && !xTrampa.has(fuente.trampa.slice(2, -1)))
		fallos.push(`senal.fuente.trampa: ${fuente.trampa} no es un parámetro con x-trampa`);
	if (v.ejecutor === 'manual@1') {
		/* Regla 3. */
		const carga = v.carga as CargaManual;
		if (fuente?.tipo === 'fichero')
			fallos.push(
				'manual@1 no admite la fuente fichero (nadie lee un fichero en un destino sin agente)'
			);
		if (v.retirada.tipo !== 'manual')
			fallos.push('manual@1 exige retirada manual con sus pasos (retirar no deja restos)');
		const todos = [
			...carga.pasos,
			...(v.retirada.tipo === 'manual' ? v.retirada.pasos : []),
			...(v.comprobacion?.prueba?.pasos ?? [])
		];
		if (
			carga.lenguaje === 'ninguno' &&
			todos.some((p) => p.orden !== undefined || p.comprobar !== undefined)
		)
			fallos.push('con lenguaje ninguno los pasos solo llevan texto (ni orden ni comprobar)');
	} else if (v.ejecutor === 'contenedor@1') {
		/* Regla 4 (la forma de la carga la dice el esquema) y regla 9. */
		const { contenedor } = v.carga as CargaContenedor;
		if (fuente && fuente.tipo !== 'fichero')
			fallos.push(
				'contenedor@1 exige la fuente fichero (el sensor lee los registros del contenedor)'
			);
		if (m.siembra.clase !== 'servicio')
			fallos.push(
				'contenedor@1 solo vale con siembra.clase servicio (el sensor la recibe como trampa de tipo contenedor)'
			);
		fallos.push(
			...[...puertosBajos(contenedor), ...parametrosDeContenedor(contenedor, props)].map(
				(e) => `carga: ${e}`
			)
		);
	} else if (new TextEncoder().encode(JSON.stringify(v.carga)).length > 65536) {
		/* Un ejecutor que esta consola no conoce: su carga se guarda opaca. */
		fallos.push(`la carga de ${v.ejecutor} pasa de 64 KB`);
	}
	/* Regla 9: el traductor propio, como el de v1. */
	if (v.senal?.eventos)
		fallos.push(...fallosDeTraductor(v.senal.eventos).map((e) => `senal.eventos.${e}`));
	(v.requisitos ?? []).forEach((r, n) => {
		if (r.siFalta === 'descarta' && r.nivel === 'avisa')
			fallos.push(`requisitos[${n}] (${r.hecho}): siFalta: descarta solo vale con nivel: exige`);
	});
	/* Reglas 5 y 6. */
	const { usos, fallos: enCodigo } = usosDe(v);
	fallos.push(...enCodigo);
	for (const u of usos) {
		const r = resolver(u, props, xTrampa);
		if ('fallo' in r) fallos.push(r.fallo);
	}
	return fallos;
}

function reglasV2(m: ManifiestoTrampaV2): string[] {
	const props = m.parametros.properties as Record<string, DefParametro>;
	const { xTrampa, fallos } = parametrosV2(props);
	/* Regla 1: cada id, y cada «antes», señala una sola vía. */
	const duenas = new Map<string, Via>();
	for (const v of m.vias) {
		if (duenas.has(v.id)) fallos.push(`vias: el id ${v.id} se repite`);
		else duenas.set(v.id, v);
	}
	for (const v of m.vias)
		for (const a of v.antes ?? []) {
			const otra = duenas.get(a);
			if (otra) fallos.push(`vias (${v.id}): antes: ${a} ya señala la vía ${otra.id}`);
			else duenas.set(a, v);
		}
	m.vias.forEach((v, i) =>
		fallos.push(...reglasDeVia(m, v, props, xTrampa).map((e) => `vias[${i}] (${v.id}): ${e}`))
	);
	if (m.senal.eventos)
		fallos.push(...fallosDeTraductor(m.senal.eventos).map((e) => `senal.eventos.${e}`));
	return fallos;
}

/*
 * Un manifiesto de trampa, v1 o v2, como honeycosa (siempre la forma v2). Un
 * v1 se valida como siempre y se normaliza; un v2, con su esquema y las reglas
 * 1 a 9. Lo que un solo manifiesto no deja ver lo comprueban validarCatalogo
 * (referencias a otros módulos) y herramientas/vias-estables.ts (regla 10).
 */
export function validarHoneycosa(dato: unknown): Resultado<Honeycosa> {
	if ((dato as { version?: unknown } | null)?.version !== 2) {
		const t = validarTrampa(dato);
		return t.ok ? { ok: true, valor: normalizar(t.valor) } : t;
	}
	if (!comprobar.trampaV2(dato)) return { ok: false, errores: errores(comprobar.trampaV2) };
	const m = dato as ManifiestoTrampaV2;
	const fallos = reglasV2(m);
	if (fallos.length) return { ok: false, errores: fallos };
	return {
		ok: true,
		valor: { ...m, origen: 2, vias: m.vias.map((v) => ({ ...v, requisitos: v.requisitos ?? [] })) }
	};
}

export function leerHoneycosa(yaml: string): Resultado<Honeycosa> {
	const r = leerYaml(yaml);
	return r.ok ? validarHoneycosa(r.valor) : r;
}

function referenciasRotas(h: Honeycosa, porId: Map<string, Honeycosa>): string[] {
	/* En v1 no hay x-trampa ni pasos con ${objetivo.…}: nada apunta a otro módulo. */
	if (h.origen !== 2) return [];
	const props = h.parametros.properties as Record<string, DefParametro>;
	const xTrampa = conXTrampa(props);
	const modulosDe = (p: string) => (props[p]['x-trampa'] as { modulos: string[] }).modulos;
	const fallos: string[] = [];
	for (const p of xTrampa)
		for (const id of modulosDe(p))
			if (!porId.has(id))
				fallos.push(`parametros.${p}: x-trampa nombra ${id}, que no está en el catálogo`);
	h.vias.forEach((v, i) => {
		for (const u of usosDe(v).usos) {
			const r = resolver(u, props, xTrampa);
			if (!('variable' in r) || r.variable.de !== 'objetivo') continue;
			const objetivo = r.variable;
			const donde = `vias[${i}] (${v.id}): ${u.donde}: ${comoSeEscribe(u)}`;
			for (const id of modulosDe(objetivo.parametro)) {
				const otro = porId.get(id);
				if (!otro) continue;
				const suyos = otro.parametros.properties as Record<string, DefParametro>;
				const campo = objetivo.exacto
					? Object.hasOwn(suyos, objetivo.campo)
						? objetivo.campo
						: undefined
					: Object.keys(suyos).find((p) => p.toUpperCase() === objetivo.campo);
				if (campo === undefined)
					fallos.push(`${donde}: ${id} no tiene el parámetro ${objetivo.campo}`);
				else if (!seguroEnOrden(suyos[campo]))
					fallos.push(
						`${donde}: ${id}.${campo} no es numérico ni declara un enum o un pattern anclado (^…$)`
					);
			}
		}
	});
	return [...new Set(fallos)];
}

/*
 * Un módulo que hace lanzar la comprobación (lo que validarHoneycosa no dejaría
 * pasar, o un error nuestro) no entra, pero no tira el catálogo entero.
 */
function rotasSinLanzar(h: Honeycosa, porId: Map<string, Honeycosa>): string[] {
	try {
		return referenciasRotas(h, porId);
	} catch (e) {
		return [`no se puede comprobar contra el catálogo: ${(e as Error).message}`];
	}
}

/*
 * Regla 6 con el catálogo entero: cada ${objetivo.<parametro>} (o
 * $sd.objetivo_<parametro>, SD_OBJETIVO_<PARAMETRO>) nombra un parámetro que
 * existe en cada módulo de su x-trampa y que puede ir en una orden, y esos
 * módulos están en el catálogo. Un módulo con referencias rotas no entra, como
 * uno inválido, y tampoco los que apuntaban a él. Lo corren una prueba de CI
 * sobre modulos/trampas y la consola al cargar el catálogo.
 */
export function validarCatalogo(honeycosas: Honeycosa[]): {
	validas: Honeycosa[];
	errores: Record<string, string[]>;
} {
	const errores: Record<string, string[]> = {};
	let validas = honeycosas;
	for (;;) {
		const porId = new Map(validas.map((h) => [h.id, h]));
		const rotas = validas
			.map((h) => [h.id, rotasSinLanzar(h, porId)] as const)
			.filter(([, f]) => f.length);
		if (!rotas.length) return { validas, errores };
		for (const [id, f] of rotas) errores[id] = f;
		validas = validas.filter((h) => !Object.hasOwn(errores, h.id));
	}
}

export function leerRespuesta(yaml: string): Resultado<ManifiestoRespuesta> {
	const r = leerYaml(yaml);
	return r.ok ? validarRespuesta(r.valor) : r;
}

/*
 * Los valores que llegan del formulario, contra el esquema de parámetros del
 * módulo. Un formulario solo manda texto: se convierte al tipo declarado y se
 * rellenan los valores por defecto. Lo que no esté declarado se rechaza.
 */
function nuevoAjvParametros() {
	const ajv = new Ajv2020({
		allErrors: true,
		strict: false,
		coerceTypes: true,
		useDefaults: true,
		removeAdditional: false
	});
	addFormats.default(ajv);
	return ajv;
}
let ajvParametros = nuevoAjvParametros();

/*
 * Ajv no suelta nada de lo que compila: guarda cada esquema en su caché y sus
 * patrones y funciones en su ámbito, aunque se quite el esquema. Compilar en
 * cada llamada dejaba unos 20 KB por llamada para siempre, y plan() valida los
 * parámetros de cada trampa cada 10 s por sensor. Así que cada esquema distinto
 * se compila una sola vez, por su JSON (llega como un objeto nuevo en cada
 * lectura del catálogo). Con demasiados distintos se empieza con un Ajv nuevo,
 * que se lleva lo del anterior.
 */
type Validador = ReturnType<typeof ajvParametros.compile>;
type Compilado = Validador | { error: string };
const compilados = new Map<string, Compilado>();
/* De sobra para un catálogo entero (cada esquema y cada parámetro de un v2). */
const MAX_COMPILADOS = 2048;

function compilarEsquema(esquema: object): Compilado {
	const clave = JSON.stringify(esquema);
	const hecho = compilados.get(clave);
	if (hecho) return hecho;
	if (compilados.size >= MAX_COMPILADOS) {
		compilados.clear();
		ajvParametros = nuevoAjvParametros();
	}
	let c: Compilado;
	try {
		/* Una copia: el que llama puede cambiar su objeto después. */
		c = ajvParametros.compile(JSON.parse(clave));
	} catch (e) {
		c = { error: (e as Error).message };
	}
	compilados.set(clave, c);
	return c;
}

export function validarParametros(
	esquema: EsquemaParametros,
	valores: Record<string, unknown>
): Resultado<Record<string, unknown>> {
	const validar = compilarEsquema({ ...esquema, additionalProperties: false });
	/* Un v2 ya no llega aquí con un esquema que no compila (validarHoneycosa); un v1, como siempre. */
	if (typeof validar !== 'function') throw new Error(validar.error);
	const copia = structuredClone(valores);
	return validar(copia)
		? { ok: true, valor: copia }
		: {
				ok: false,
				errores: (validar.errors ?? []).map((e) => {
					const p = e.params as { missingProperty?: string; additionalProperty?: string };
					if (p.additionalProperty)
						return `${p.additionalProperty}: el módulo no declara este parámetro`;
					const clave = e.instancePath.slice(1) || p.missingProperty || '/';
					const titulo =
						(esquema.properties[clave] as { title?: string } | undefined)?.title ?? clave;
					const motivo: Record<string, string> = {
						required: 'es obligatorio',
						pattern: 'no tiene el formato esperado',
						minimum: `tiene que ser ${(e.params as { limit?: number }).limit} o más`,
						maximum: `tiene que ser ${(e.params as { limit?: number }).limit} o menos`,
						enum: 'no es una de las opciones',
						type: 'no es del tipo esperado',
						maxLength: 'es demasiado largo'
					};
					return `${titulo}: ${motivo[e.keyword] ?? e.message}`;
				})
			};
}
