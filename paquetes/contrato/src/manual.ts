import { createHash } from 'node:crypto';
import { EJECUTORES } from './ejecutores.ts';
import { viaDe } from './honeycosa.ts';
import type { CargaManual, Honeycosa, Marca, Paso } from './tipos.ts';
import { variablesDeVia, type Resultado, type VariableDeVia } from './validar.ts';

/*
 * La vía manual (docs/diseno/modulo-despliegue.md §6.3): los pasos que da la
 * consola para que el cliente ponga, compruebe y retire una honeycosa con sus
 * propias manos en un destino sin agente, y su exportación a .ps1, .sh, .md y
 * .txt. Puro: sin base de datos, ficheros, red ni reloj (la hora llega en el
 * contexto). El sha256 es el de node:crypto, como en cadena.ts.
 *
 * En los textos para el cliente, cada ${…} se sustituye por su valor (Svelte
 * lo escapa al pintarlo). En las órdenes y en las comprobaciones, nunca: el
 * script empieza con un bloque de variables con cada valor como literal entre
 * comillas simples, y el código las usa ($sd.<clave> en PowerShell, SD_<CLAVE>
 * en sh). Un valor con saltos de línea o caracteres de control no se acepta.
 */

export type LenguajeManual = CargaManual['lenguaje'];
export type FormatoPasos = 'ps1' | 'sh' | 'md' | 'txt';
/* Qué pasos lleva un script: los de colocar, los de retirar o los de la prueba. */
export type PartePasos = 'colocar' | 'retirar' | 'probar';

export interface PasoGenerado {
	n: number;
	texto: string;
	orden?: string;
	comprobar?: string;
}

export interface ContextoManual {
	trampa: { id: string; nombre: string };
	destino: { id: string; nombre: string; direccion?: string };
	/*
	 * Las trampas del cliente por id, para los parámetros con x-trampa: la
	 * dirección de su destino y sus parámetros ya validados (con sus default).
	 */
	trampas: Record<string, { direccion?: string; parametros: Record<string, unknown> }>;
	/*
	 * La URL de la baliza de esta honeycosa (§2.5), para las vías de nube que
	 * la pegan en un webhook o en un píxel: solo cuando el módulo acuña baliza
	 * (las de fichero y las de la tanda de conectores, H28–H31).
	 */
	baliza_url?: string | null;
	/* Cuándo se generan (ISO): renderizar no mira el reloj. */
	generado: string;
}

export interface PasosGenerados {
	version: 1;
	trampa: string;
	destino: string;
	via: string;
	modulo: string;
	versionModulo: string;
	/* Para la cabecera y el documento de cambios: lo guardado se explica solo aunque el módulo cambie. */
	nombres: { trampa: string; destino: string; via: string; modulo: string };
	lenguaje: LenguajeManual;
	generado: string;
	/* Las del bloque, ya como texto: clave (con _ en lugar de .) → valor. */
	variables: Record<string, string>;
	pasos: PasoGenerado[];
	retirada: PasoGenerado[];
	/* Fuente «trampa»: la marca con los valores reales, con la que se le atribuyen los eventos del objetivo (§8.5). */
	marca?: Marca;
	/*
	 * Los pasos y la marca de la prueba tal como los escribió el módulo, con sus
	 * ${…}: probar() los rellena con estas variables y el nonce al pulsar «Probar».
	 */
	prueba?: { pasos: PasoGenerado[]; marca?: Marca; ventanaMin: number };
	/* Del JSON canónico de todo lo demás. */
	sha256: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const NONCE = /^[a-z0-9]{8}$/;
const HUECO = /\$\{([^}]*)\}/g;
/* Una clave que el código puede nombrar: $sd.<clave>, SD_<CLAVE>. */
const IDENTIFICADOR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/*
 * Lo que un valor no puede llevar: saltos de línea y caracteres de control
 * (también los de Unicode, U+2028 y U+2029), mitades sueltas de un par
 * sustituto (no se pueden escribir en UTF-8) y los que invierten la dirección
 * del texto, que harían que un literal se viera distinto de lo que es.
 */
const PROHIBIDO = /[\p{Cc}\p{Cs}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/* La clave en el bloque de variables: destino.direccion → destino_direccion. */
const claveDe = (nombre: string) => nombre.replaceAll('.', '_');

const porCodigo = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* PowerShell: '…', con cada comilla simple doblada (también las tipográficas, que PowerShell trata igual). */
export function literalPowershell(valor: string): string {
	return `'${valor.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}

/* sh: '…'; dentro, nada es especial salvo la propia comilla, que se cierra, se escapa y se vuelve a abrir. */
export function literalSh(valor: string): string {
	return `'${valor.replaceAll("'", `'\\''`)}'`;
}

function comoTexto(v: unknown): string | undefined {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	if (typeof v === 'boolean') return String(v);
	return undefined;
}

const ETIQUETAS = {
	'trampa.id': 'Id de la trampa',
	'trampa.nombre': 'Nombre de la trampa',
	'destino.nombre': 'Nombre del destino',
	'destino.direccion': 'Dirección del destino',
	baliza_url: 'URL de la baliza'
} as const;

/* Por qué puede faltar cada variable de contexto, con el texto que ve el cliente. */
function faltaDe(nombre: keyof typeof ETIQUETAS, c: Omit<ContextoManual, 'generado'>): string {
	switch (nombre) {
		case 'destino.direccion':
			return `${c.destino.nombre} no tiene dirección; ponla en Destinos`;
		case 'baliza_url':
			return 'falta la URL de la baliza de esta honeycosa (se acuña al darle de alta)';
		default:
			return `falta la variable ${nombre}`;
	}
}

type Resuelta = { clave: string; origen: string; valor: string; etiqueta: string };

/* Cómo se llama cada parámetro para el cliente, en los errores: su título o, si no tiene, su nombre. */
function tituloDe(h: Honeycosa): (parametro: string) => string {
	const props = h.parametros.properties as Record<string, { title?: unknown } | undefined>;
	return (p) => {
		const t = Object.hasOwn(props, p) ? props[p]?.title : undefined;
		return typeof t === 'string' ? t : p;
	};
}

/* El valor de una variable de la vía, o por qué no lo tiene. */
function resolver(
	v: Exclude<VariableDeVia, { de: 'nonce' }>,
	p: Record<string, unknown>,
	c: Omit<ContextoManual, 'generado'>,
	titulo: (parametro: string) => string
): Resuelta | { error: string } {
	const conValor = (
		clave: string,
		origen: string,
		etiqueta: string,
		valor: unknown,
		falta: string
	): Resuelta | { error: string } => {
		if (valor === undefined || valor === null) return { error: `${etiqueta}: ${falta}` };
		const texto = comoTexto(valor);
		if (texto === undefined)
			return { error: `${etiqueta}: no es un texto, un número ni un sí o no` };
		return { clave, origen, valor: texto, etiqueta };
	};
	switch (v.de) {
		case 'parametro':
			return conValor(
				claveDe(v.parametro),
				`parametro:${v.parametro}`,
				titulo(v.parametro),
				Object.hasOwn(p, v.parametro) ? p[v.parametro] : undefined,
				'falta, y lo usan los pasos'
			);
		case 'contexto': {
			const valores: Record<typeof v.nombre, string | undefined> = {
				'trampa.id': c.trampa.id,
				'trampa.nombre': c.trampa.nombre,
				'destino.nombre': c.destino.nombre,
				'destino.direccion': c.destino.direccion || undefined,
				baliza_url: c.baliza_url || undefined
			};
			return conValor(
				claveDe(v.nombre),
				`contexto:${v.nombre}`,
				ETIQUETAS[v.nombre],
				valores[v.nombre],
				faltaDe(v.nombre, c)
			);
		}
		case 'objetivo-direccion':
		case 'objetivo': {
			const etiqueta = titulo(v.parametro);
			const id = Object.hasOwn(p, v.parametro) ? p[v.parametro] : undefined;
			if (typeof id !== 'string' || id === '')
				return { error: `${etiqueta}: falta la trampa a la que apunta` };
			const t = Object.hasOwn(c.trampas, id) ? c.trampas[id] : undefined;
			if (!t) return { error: `${etiqueta}: la trampa ${id} no existe` };
			if (v.de === 'objetivo-direccion')
				return conValor(
					claveDe(`${v.parametro}.direccion`),
					`objetivo:${v.parametro}:direccion`,
					etiqueta,
					t.direccion || undefined,
					`el destino de la trampa ${id} no tiene dirección; ponla en Destinos`
				);
			/* En sh el campo llega en mayúsculas: cómo se escribe lo dicen los parámetros del objetivo. */
			const campo = v.exacto
				? Object.hasOwn(t.parametros, v.campo)
					? v.campo
					: undefined
				: Object.keys(t.parametros).find((k) => k.toUpperCase() === v.campo);
			if (campo === undefined) {
				const nombre = v.exacto
					? v.campo
					: `el parámetro de SD_${v.parametro.toUpperCase()}_${v.campo}`;
				return { error: `${etiqueta}: la trampa ${id} no tiene ${nombre}` };
			}
			return conValor(
				claveDe(`${v.parametro}.${campo}`),
				`objetivo:${v.parametro}:${campo}`,
				etiqueta,
				t.parametros[campo],
				`la trampa ${id} no tiene ${campo}`
			);
		}
	}
}

function paso(p: Paso, i: number, texto: string): PasoGenerado {
	/* El código se guarda con saltos \n y sin los del final; cada formato pone los suyos. */
	const codigo = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
	return {
		n: i + 1,
		texto,
		...(p.orden === undefined ? {} : { orden: codigo(p.orden) }),
		...(p.comprobar === undefined ? {} : { comprobar: codigo(p.comprobar) })
	};
}

const marcaCon = (m: Marca, valor: (t: string) => string): Marca =>
	'igual' in m
		? { campo: m.campo, igual: valor(m.igual) }
		: { campo: m.campo, contiene: valor(m.contiene) };

/* JSON con las claves ordenadas y sin espacios: el mismo objeto da los mismos bytes. */
function canonico(x: unknown): string {
	if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
	if (x !== null && typeof x === 'object') {
		const o = x as Record<string, unknown>;
		return `{${Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort(porCodigo)
			.map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(x);
}

/*
 * El sha256 de unos pasos: el del JSON canónico de todo salvo el propio
 * sha256. No depende del orden de las claves (jsonb lo cambia al guardar).
 */
export function sha256Pasos(p: Omit<PasosGenerados, 'sha256'> & { sha256?: string }): string {
	const { sha256: _, ...resto } = p;
	return createHash('sha256').update(canonico(resto)).digest('hex');
}

/*
 * Los pasos de una vía manual@1 para una trampa en un destino: los de
 * colocar, los de retirar (se guardan para retirar luego exactamente lo que
 * se puso, aunque el módulo cambie) y la prueba. Los parámetros son los que
 * dio validarParametros. Falla, con un texto por cada causa, si a una variable
 * que usan los pasos le falta el valor (también un objetivo_* sin trampa, sin
 * dirección o sin ese parámetro) o si un valor lleva saltos de línea o
 * caracteres de control: la consola lo enseña como parametros.invalidos.
 * Lanza si la vía no existe o no es manual@1, o si el contexto no tiene la
 * forma que garantiza la consola (ids que no son slug, hora que no es ISO).
 */
export function renderizar(
	h: Honeycosa,
	viaId: string,
	parametros: Record<string, unknown>,
	c: ContextoManual
): Resultado<PasosGenerados> {
	const via = viaDe(h, viaId);
	if (!via) throw new Error(`${h.id} no tiene la vía ${viaId}`);
	if (via.ejecutor !== 'manual@1')
		throw new Error(
			`la vía ${via.id} de ${h.id} es ${via.ejecutor}: solo se generan pasos de una manual@1`
		);
	if (!SLUG.test(c.trampa.id)) throw new Error(`el id de trampa ${c.trampa.id} no es un slug`);
	if (!SLUG.test(c.destino.id)) throw new Error(`el id de destino ${c.destino.id} no es un slug`);
	if (!ISO.test(c.generado)) throw new Error(`la hora ${c.generado} no es ISO (UTC)`);
	const { usos, fallos } = variablesDeVia(via, h.parametros);
	if (fallos.length)
		throw new Error(`la vía ${via.id} de ${h.id} no es válida: ${fallos.join('; ')}`);

	const titulo = tituloDe(h);
	const errores: string[] = [];
	const variables = new Map<string, Resuelta>();
	/* Cada hueco de un texto, por su nombre (${objetivo.direccion}), con su valor. */
	const huecos = new Map<string, string>();
	for (const u of usos) {
		if (u.variable.de === 'nonce') continue;
		const r = resolver(u.variable, parametros, c, titulo);
		if ('error' in r) {
			errores.push(r.error);
			continue;
		}
		if (PROHIBIDO.test(r.valor)) {
			errores.push(`${r.etiqueta}: lleva saltos de línea o caracteres de control`);
			continue;
		}
		/* PowerShell no distingue mayúsculas en las claves y sh las pone todas en mayúsculas. */
		const otra = [...variables.values()].find(
			(x) =>
				x.clave.toLowerCase() === r.clave.toLowerCase() &&
				(x.clave !== r.clave || x.origen !== r.origen)
		);
		if (otra)
			errores.push(
				`${r.etiqueta}: su variable ${r.clave} se confunde en el bloque con ${otra.clave} (${otra.etiqueta})`
			);
		else if (r.clave.toLowerCase() === 'nonce')
			errores.push(`${r.etiqueta}: su variable ${r.clave} se confunde con el nonce de la prueba`);
		else variables.set(r.clave, r);
		if (u.forma === 'texto') huecos.set(u.nombre, r.valor);
	}
	for (const [etiqueta, valor] of [
		[ETIQUETAS['trampa.nombre'], c.trampa.nombre],
		[ETIQUETAS['destino.nombre'], c.destino.nombre]
	])
		if (PROHIBIDO.test(valor))
			errores.push(`${etiqueta}: lleva saltos de línea o caracteres de control`);
	if (errores.length) return { ok: false, errores: [...new Set(errores)] };

	/* Una sola pasada: un ${…} que venga dentro de un valor se queda tal cual. */
	const sustituir = (t: string) =>
		t.replace(HUECO, (todo, nombre: string) => huecos.get(nombre) ?? todo);
	const carga = via.carga as CargaManual;
	const fuente = via.senal.fuente;
	const prueba = via.comprobacion?.prueba;
	const sinSha: Omit<PasosGenerados, 'sha256'> = {
		version: 1,
		trampa: c.trampa.id,
		destino: c.destino.id,
		via: via.id,
		modulo: h.id,
		versionModulo: h.versionModulo,
		nombres: {
			trampa: c.trampa.nombre,
			destino: c.destino.nombre,
			via: via.nombre ?? EJECUTORES['manual@1'].nombre,
			modulo: h.nombre
		},
		lenguaje: carga.lenguaje,
		generado: c.generado,
		variables: Object.fromEntries(
			[...variables.keys()].sort(porCodigo).map((k) => [k, variables.get(k)!.valor])
		),
		pasos: carga.pasos.map((p, i) => paso(p, i, sustituir(p.texto))),
		retirada:
			via.retirada.tipo === 'manual'
				? via.retirada.pasos.map((p, i) => paso(p, i, sustituir(p.texto)))
				: [],
		...(fuente.tipo === 'trampa' ? { marca: marcaCon(fuente.marca, sustituir) } : {}),
		...(prueba
			? {
					prueba: {
						pasos: prueba.pasos.map((p, i) => paso(p, i, p.texto)),
						...(prueba.marca ? { marca: marcaCon(prueba.marca, (t) => t) } : {}),
						ventanaMin: prueba.ventanaMin ?? 15
					}
				}
			: {})
	};
	return { ok: true, valor: { ...sinSha, sha256: sha256Pasos(sinSha) } };
}

/* Los ${…} de la prueba con las variables guardadas y el nonce, en una sola pasada. */
function rellenar(t: string, variables: Record<string, string>, nonce: string): string {
	return t.replace(HUECO, (todo, nombre: string) => {
		if (nombre === 'nonce') return nonce;
		const k = claveDe(nombre);
		return Object.hasOwn(variables, k) ? variables[k] : todo;
	});
}

function pruebaCon(p: PasosGenerados, nonce: string): NonNullable<PasosGenerados['prueba']> {
	if (!p.prueba) throw new Error(`los pasos de ${p.trampa} no tienen prueba`);
	const r = (t: string) => rellenar(t, p.variables, nonce);
	return {
		pasos: p.prueba.pasos.map((x) => ({ ...x, texto: r(x.texto) })),
		...(p.prueba.marca ? { marca: marcaCon(p.prueba.marca, r) } : {}),
		ventanaMin: p.prueba.ventanaMin
	};
}

/*
 * La prueba lista para «Probar»: los textos y la marca con las variables con
 * que se generaron los pasos y con el nonce (8 caracteres [a-z0-9]). Las
 * órdenes no cambian: el nonce va en el bloque de variables del script.
 */
export function probar(p: PasosGenerados, nonce: string): NonNullable<PasosGenerados['prueba']> {
	if (!NONCE.test(nonce)) throw new Error(`el nonce ${nonce} no son 8 caracteres [a-z0-9]`);
	return pruebaCon(p, nonce);
}

/* Lo que da «Probar» en una vía que no guarda pasos (una contenedor@1): la prueba ya rellena. */
export interface PruebaDeVia {
	pasos: PasoGenerado[];
	marca?: Marca;
	ventanaMin: number;
	/* Los valores que usa la prueba, con el nonce: para enseñarlos junto a sus órdenes, si las tiene. */
	variables: Record<string, string>;
}

/*
 * La prueba de una vía que no guarda pasos (la de una contenedor@1, §8.3):
 * sus textos y su marca con los parámetros de la trampa, su destino y el
 * nonce, en una sola pasada (un ${…} que venga dentro de un valor se queda
 * tal cual). Las de manual@1 se rellenan con probar(), con lo que se guardó
 * al generar sus pasos. null si la vía no declara prueba. Falla, con un texto
 * por cada causa, si a una variable que usa la prueba le falta el valor (la
 * dirección del destino, sobre todo) o lleva saltos de línea o caracteres de
 * control; lanza si la vía no existe o el nonce no son 8 caracteres [a-z0-9].
 */
export function pruebaDeVia(
	h: Honeycosa,
	viaId: string,
	parametros: Record<string, unknown>,
	c: Omit<ContextoManual, 'generado'>,
	nonce: string
): Resultado<PruebaDeVia> | null {
	const via = viaDe(h, viaId);
	if (!via) throw new Error(`${h.id} no tiene la vía ${viaId}`);
	if (!NONCE.test(nonce)) throw new Error(`el nonce ${nonce} no son 8 caracteres [a-z0-9]`);
	const prueba = via.comprobacion?.prueba;
	if (!prueba) return null;
	const { usos, fallos } = variablesDeVia(via, h.parametros);
	if (fallos.length)
		throw new Error(`la vía ${via.id} de ${h.id} no es válida: ${fallos.join('; ')}`);
	const titulo = tituloDe(h);
	const errores: string[] = [];
	const variables: Record<string, string> = {};
	const huecos = new Map<string, string>([['nonce', nonce]]);
	for (const u of usos) {
		if (!u.prueba || u.variable.de === 'nonce') continue;
		const r = resolver(u.variable, parametros, c, titulo);
		if ('error' in r) {
			errores.push(r.error);
			continue;
		}
		if (PROHIBIDO.test(r.valor)) {
			errores.push(`${r.etiqueta}: lleva saltos de línea o caracteres de control`);
			continue;
		}
		if (r.clave.toLowerCase() === 'nonce') {
			errores.push(`${r.etiqueta}: su variable ${r.clave} se confunde con el nonce de la prueba`);
			continue;
		}
		variables[r.clave] = r.valor;
		if (u.forma === 'texto') huecos.set(u.nombre, r.valor);
	}
	if (errores.length) return { ok: false, errores: [...new Set(errores)] };
	const sustituir = (t: string) =>
		t.replace(HUECO, (todo, nombre: string) => huecos.get(nombre) ?? todo);
	return {
		ok: true,
		valor: {
			pasos: prueba.pasos.map((p, i) => paso(p, i, sustituir(p.texto))),
			...(prueba.marca ? { marca: marcaCon(prueba.marca, sustituir) } : {}),
			ventanaMin: prueba.ventanaMin ?? 15,
			variables: Object.fromEntries(
				[...Object.keys(variables), 'nonce']
					.sort(porCodigo)
					.map((k) => [k, k === 'nonce' ? nonce : variables[k]])
			)
		}
	};
}

/* Los formatos en que se pueden exportar: un script solo en su lenguaje; el documento, siempre. */
export function formatosDe(p: Pick<PasosGenerados, 'lenguaje'>): FormatoPasos[] {
	if (p.lenguaje === 'powershell') return ['ps1', 'md', 'txt'];
	if (p.lenguaje === 'sh') return ['sh', 'md', 'txt'];
	return ['md', 'txt'];
}

const QUE: Record<PartePasos, string> = {
	colocar: 'Colocar',
	retirar: 'Retirar',
	probar: 'Probar'
};

const FIN: Record<PartePasos, string> = {
	colocar: 'Sugardaddy: pasos hechos. Vuelve a la consola y pulsa «Ya está hecho».',
	retirar: 'Sugardaddy: pasos hechos. Vuelve a la consola y pulsa «Ya lo he quitado».',
	probar: 'Sugardaddy: prueba hecha. La consola la verá cuando llegue el evento.'
};

const LENGUAJES: Record<LenguajeManual, string> = {
	powershell: 'PowerShell',
	sh: 'sh',
	ninguno: 'pasos a mano, sin código'
};

/* Cualquier salto de línea parte un comentario: lo que va detrás nunca puede ser código. */
const lineas = (t: string) => t.split(/\r\n|[\n\r\u2028\u2029\u0085]/);
const comentario = (t: string) => lineas(t).map((l) => (l ? `# ${l}` : '#'));
const codigo = (t: string) => t.split('\n');

const cabecera = (p: PasosGenerados) =>
	`Sugardaddy · trampa ${p.trampa} · destino ${p.destino} · vía ${p.via} · ${p.generado} · sha256 ${p.sha256}`;
const subtitulo = (p: PasosGenerados, parte: PartePasos) =>
	`${QUE[parte]} «${p.nombres.trampa}» en ${p.nombres.destino} · ${p.nombres.modulo} ${p.versionModulo} · ${p.nombres.via}`;

/* Las variables que pueden ir en el bloque de un script, en orden. */
const delBloque = (variables: Record<string, string>) =>
	Object.keys(variables)
		.filter((k) => IDENTIFICADOR.test(k))
		.sort(porCodigo)
		.map((k) => [k, variables[k]] as const);

/*
 * PowerShell 5.1 o posterior. Cada orden va en un try: si falla, el script
 * para y dice en qué paso. Una comprobación tiene que dar True como último
 * valor; si no, para con el texto del paso. El código va sin sangrar, para
 * que un here-string (que cierra en la columna 0) siga valiendo.
 */
function scriptPowershell(
	p: PasosGenerados,
	parte: PartePasos,
	pasos: PasoGenerado[],
	variables: Record<string, string>
): string {
	const l = [
		...comentario(cabecera(p)),
		...comentario(subtitulo(p, parte)),
		'#Requires -Version 5.1',
		'Set-StrictMode -Version 3',
		"$ErrorActionPreference = 'Stop'",
		'$sd = @{',
		...delBloque(variables).map(([k, v]) => `  ${literalPowershell(k)} = ${literalPowershell(v)}`),
		'}'
	];
	for (const x of pasos) {
		const de = `${x.n} de ${pasos.length}`;
		l.push('', `# Paso ${de}`, ...comentario(x.texto));
		l.push(`Write-Host ${literalPowershell(`Paso ${de}: ${x.texto}`)}`);
		if (x.orden !== undefined)
			l.push(
				'try {',
				...codigo(x.orden),
				'} catch {',
				`  throw (${literalPowershell(`Sugardaddy: ha fallado el paso ${de}: `)} + $_)`,
				'}'
			);
		if (x.comprobar !== undefined)
			l.push(
				'$sdComprobado = @(& {',
				...codigo(x.comprobar),
				'})',
				'if ($sdComprobado.Count -eq 0 -or $sdComprobado[-1] -isnot [bool] -or -not $sdComprobado[-1]) {',
				`  throw ${literalPowershell(`Sugardaddy: no se cumple el paso ${de}: ${x.texto}`)}`,
				'}'
			);
	}
	l.push('', `Write-Host ${literalPowershell(FIN[parte])}`);
	return `\uFEFF${l.join('\r\n')}\r\n`;
}

/*
 * sh POSIX (dash, BusyBox, bash). set -eu: una orden que falla para el
 * script, y la trampa de salida dice en qué paso. Una comprobación tiene que
 * terminar con código 0; si no, para con el texto del paso.
 */
function scriptSh(
	p: PasosGenerados,
	parte: PartePasos,
	pasos: PasoGenerado[],
	variables: Record<string, string>
): string {
	const l = [
		'#!/bin/sh',
		...comentario(cabecera(p)),
		...comentario(subtitulo(p, parte)),
		'set -eu',
		...delBloque(variables).map(([k, v]) => `SD_${k.toUpperCase()}=${literalSh(v)}`),
		'',
		'sd_paso=',
		`trap 'sd_estado=$?; if [ "$sd_estado" -ne 0 ] && [ -n "$sd_paso" ]; then printf "Sugardaddy: ha fallado el paso %s.\\n" "$sd_paso" >&2; fi' EXIT`
	];
	for (const x of pasos) {
		const de = `${x.n} de ${pasos.length}`;
		l.push('', `# Paso ${de}`, ...comentario(x.texto));
		l.push(`printf '%s\\n' ${literalSh(`Paso ${de}: ${x.texto}`)}`, `sd_paso=${literalSh(de)}`);
		if (x.orden !== undefined) l.push(...codigo(x.orden));
		if (x.comprobar !== undefined)
			l.push(
				'if ! (',
				...codigo(x.comprobar),
				'); then',
				'\tsd_paso=',
				`\tprintf '%s\\n' ${literalSh(`Sugardaddy: no se cumple el paso ${de}: ${x.texto}`)} >&2`,
				'\texit 1',
				'fi'
			);
	}
	l.push('', 'sd_paso=', `printf '%s\\n' ${literalSh(FIN[parte])}`);
	return `${l.join('\n')}\n`;
}

/* Markdown: los caracteres que darían formato, enlaces o HTML, escapados; también un marcador de lista al principio. */
function md(t: string): string {
	return lineas(t)
		.map((l) =>
			l
				.replace(/^\s+/, '')
				.replace(/[\\`*_[\]<>|~#&]/g, '\\$&')
				.replace(/^(\d+)([.)])/, '$1\\$2')
				.replace(/^([-+=])/, '\\$1')
		)
		.join(' ');
}

/* Una valla de código más larga que cualquier tira de ` del contenido. */
function valla(contenido: string, minimo: number): string {
	const tira = Math.max(0, ...[...contenido.matchAll(/`+/g)].map((m) => m[0].length));
	return '`'.repeat(Math.max(minimo, tira + 1));
}

function enLinea(t: string): string {
	const v = valla(t, 1);
	return /^`|`$/.test(t) ? `${v} ${t} ${v}` : `${v}${t}${v}`;
}

function bloqueMd(contenido: string, lenguaje: string, sangria: string): string[] {
	const v = valla(contenido, 3);
	return [`${v}${lenguaje}`, ...contenido.split('\n'), v].map((x) => (x ? sangria + x : x));
}

function bloqueVariables(
	p: Pick<PasosGenerados, 'lenguaje'>,
	variables: Record<string, string>
): string {
	if (p.lenguaje === 'powershell')
		return [
			'$sd = @{',
			...delBloque(variables).map(
				([k, v]) => `  ${literalPowershell(k)} = ${literalPowershell(v)}`
			),
			'}'
		].join('\n');
	return delBloque(variables)
		.map(([k, v]) => `SD_${k.toUpperCase()}=${literalSh(v)}`)
		.join('\n');
}

/*
 * El bloque de variables de unos pasos tal como empieza su script ($sd = @{…}
 * en PowerShell, SD_<CLAVE>='…' en sh): la consola lo enseña arriba de los
 * pasos, para copiarlo primero (§6.3). Con lenguaje «ninguno» no hay código
 * que lo use: vacío.
 */
export function bloqueDeVariables(p: Pick<PasosGenerados, 'lenguaje' | 'variables'>): string {
	return p.lenguaje === 'ninguno' ? '' : bloqueVariables(p, p.variables);
}

const COMPROBAR: Record<LenguajeManual, string> = {
	powershell: 'Comprobación (tiene que dar True):',
	sh: 'Comprobación (tiene que terminar con código 0):',
	ninguno: 'Comprobación:'
};

const textoMarca = (m: Marca) =>
	'igual' in m ? `${m.campo} igual a «${m.igual}»` : `${m.campo} que contenga «${m.contiene}»`;

/* Lo que no puede faltar en el documento de cambios, sea .md o .txt. */
function documento(p: PasosGenerados, nonce: string | undefined) {
	const prueba = p.prueba ? pruebaCon(p, nonce ?? '(código de la prueba)') : undefined;
	return {
		titulo: `Pasos de «${p.nombres.trampa}» en ${p.nombres.destino}`,
		intro: `Generados por Sugardaddy el ${p.generado}, para la gestión de cambios: qué se va a hacer en ${p.nombres.destino}, cómo se comprueba y cómo se retira. Las órdenes de cada paso se pueden volver a ejecutar sin romper nada.`,
		ficha: [
			['Trampa', `${p.nombres.trampa}`, p.trampa],
			['Honeycosa', `${p.nombres.modulo}, versión ${p.versionModulo}`, p.modulo],
			['Destino', p.nombres.destino, p.destino],
			['Forma', `${p.nombres.via}, ${LENGUAJES[p.lenguaje]}`, p.via]
		] as const,
		variables: (nonce ? { ...p.variables, nonce } : p.variables) as Record<string, string>,
		senal: p.marca
			? `La señal llega por otra trampa: un evento suyo con ${textoMarca(p.marca)} (sin distinguir mayúsculas) dice que se ha usado lo que se siembra aquí.`
			: undefined,
		prueba: prueba
			? {
					intro: `Con «Probar» en la consola, que da el código de la prueba y espera el evento ${prueba.ventanaMin} minutos.`,
					pasos: prueba.pasos,
					marca: prueba.marca ? `Cuenta el evento con ${textoMarca(prueba.marca)}.` : undefined
				}
			: undefined,
		sinPrueba: 'Queda comprobada con el primer evento real que llegue por su señal.'
	};
}

function documentoMd(p: PasosGenerados, nonce: string | undefined): string {
	const d = documento(p, nonce);
	const fence = p.lenguaje === 'ninguno' ? '' : p.lenguaje === 'sh' ? 'sh' : 'powershell';
	const lista = (pasos: PasoGenerado[]) =>
		pasos.flatMap((x) => {
			const marca = `${x.n}. `;
			const sangria = ' '.repeat(marca.length);
			const l = [`${marca}${md(x.texto)}`];
			if (x.orden !== undefined) l.push('', ...bloqueMd(x.orden, fence, sangria));
			if (x.comprobar !== undefined)
				l.push(
					'',
					`${sangria}${COMPROBAR[p.lenguaje]}`,
					'',
					...bloqueMd(x.comprobar, fence, sangria)
				);
			return [...l, ''];
		});
	const l = [`# ${md(d.titulo)}`, '', md(d.intro), ''];
	for (const [que, nombre, id] of d.ficha) l.push(`- **${que}:** ${md(nombre)} (${enLinea(id)})`);
	l.push(`- **sha256 de los pasos:** ${enLinea(p.sha256)}`, '', '## Variables', '');
	if (p.lenguaje === 'ninguno')
		for (const k of Object.keys(d.variables).sort(porCodigo))
			l.push(`- ${enLinea(k)}: ${md(d.variables[k])}`);
	else
		l.push(
			'Los pasos las usan desde este bloque. En el script exportado va al principio; si copias los pasos a mano, cópialo primero.',
			'',
			...bloqueMd(bloqueVariables(p, d.variables), fence, '')
		);
	l.push('', '## Qué se va a hacer', '', ...lista(p.pasos), '## Cómo se comprueba', '');
	if (d.senal) l.push(md(d.senal), '');
	if (d.prueba) {
		l.push(md(d.prueba.intro), '', ...lista(d.prueba.pasos));
		if (d.prueba.marca) l.push(md(d.prueba.marca), '');
	}
	l.push(md(d.sinPrueba), '', '## Cómo se retira', '', ...lista(p.retirada));
	return `${l.join('\n').replace(/\n+$/, '')}\n`;
}

function documentoTxt(p: PasosGenerados, nonce: string | undefined): string {
	const d = documento(p, nonce);
	const plano = (t: string) => lineas(t).join(' ');
	const sangrar = (t: string, s: string) => t.split('\n').map((x) => (x ? s + x : x));
	const lista = (pasos: PasoGenerado[]) =>
		pasos.flatMap((x) => {
			const l = [`${x.n}. ${plano(x.texto)}`];
			if (x.orden !== undefined) l.push('', ...sangrar(x.orden, '    '));
			if (x.comprobar !== undefined)
				l.push('', `   ${COMPROBAR[p.lenguaje]}`, '', ...sangrar(x.comprobar, '    '));
			return [...l, ''];
		});
	const titulo = plano(d.titulo);
	const l = [titulo, '='.repeat([...titulo].length), '', plano(d.intro), ''];
	for (const [que, nombre, id] of d.ficha) l.push(`${que}: ${plano(nombre)} (${plano(id)})`);
	l.push(`sha256 de los pasos: ${p.sha256}`, '', 'VARIABLES', '');
	if (p.lenguaje === 'ninguno')
		for (const k of Object.keys(d.variables).sort(porCodigo))
			l.push(`${k}: ${plano(d.variables[k])}`);
	else
		l.push(
			'Los pasos las usan desde este bloque. En el script exportado va al principio; si copias los pasos a mano, cópialo primero.',
			'',
			...sangrar(bloqueVariables(p, d.variables), '    ')
		);
	l.push('', 'QUÉ SE VA A HACER', '', ...lista(p.pasos), 'CÓMO SE COMPRUEBA', '');
	if (d.senal) l.push(plano(d.senal), '');
	if (d.prueba) {
		l.push(plano(d.prueba.intro), '', ...lista(d.prueba.pasos));
		if (d.prueba.marca) l.push(plano(d.prueba.marca), '');
	}
	l.push(plano(d.sinPrueba), '', 'CÓMO SE RETIRA', '', ...lista(p.retirada));
	return `${l.join('\n').replace(/\n+$/, '')}\n`;
}

/*
 * Un fichero para descargar. .ps1: UTF-8 con BOM y CRLF (PowerShell 5.1 lee
 * como ANSI un fichero sin BOM y rompe las tildes). .sh: UTF-8 sin BOM, LF y
 * sh POSIX. Los dos llevan los pasos de una parte (colocar, por defecto;
 * retirar; o probar, con su nonce en el bloque de variables). .md y .txt: el
 * documento para la gestión de cambios (qué se hace, cómo se comprueba y cómo
 * se retira), con el nonce si se da. Lanza si los pasos no cuadran con su
 * sha256 (no se exporta algo distinto de lo que se generó) o si el formato no
 * es de su lenguaje.
 */
export function exportar(
	p: PasosGenerados,
	formato: FormatoPasos,
	opciones: { parte?: PartePasos; nonce?: string } = {}
): { nombre: string; tipo: string; contenido: Uint8Array } {
	if (sha256Pasos(p) !== p.sha256)
		throw new Error(`los pasos de ${p.trampa} no cuadran con su sha256: no se exportan`);
	if (!formatosDe(p).includes(formato))
		throw new Error(`los pasos de ${p.trampa} son ${p.lenguaje}: no se exportan como .${formato}`);
	const { parte = 'colocar', nonce } = opciones;
	if (nonce !== undefined && !NONCE.test(nonce))
		throw new Error(`el nonce ${nonce} no son 8 caracteres [a-z0-9]`);
	const base = `sugardaddy-${p.trampa.replace(/[^a-z0-9-]/g, '-')}`;
	const fichero = (nombre: string, tipo: string, texto: string) => ({
		nombre,
		tipo,
		contenido: new TextEncoder().encode(texto)
	});
	if (formato === 'md')
		return fichero(`${base}.md`, 'text/markdown; charset=utf-8', documentoMd(p, nonce));
	if (formato === 'txt')
		return fichero(`${base}.txt`, 'text/plain; charset=utf-8', documentoTxt(p, nonce));
	let pasos = parte === 'colocar' ? p.pasos : p.retirada;
	let variables = p.variables;
	if (parte === 'probar') {
		if (nonce === undefined) throw new Error('la prueba se exporta con su nonce');
		pasos = pruebaCon(p, nonce).pasos;
		variables = { ...p.variables, nonce };
	}
	return formato === 'ps1'
		? fichero(
				`${base}-${parte}.ps1`,
				'text/plain; charset=utf-8',
				scriptPowershell(p, parte, pasos, variables)
			)
		: fichero(
				`${base}-${parte}.sh`,
				'text/x-shellscript; charset=utf-8',
				scriptSh(p, parte, pasos, variables)
			);
}
