/*
 * Nombres para las trampas a partir del dominio del cliente, para que parezcan de su
 * red: con acme.es, un servidor de ficheros es ACMEFS03 o ACME-FS-07, y no el FS01 que
 * traen todas. Es el primer paso del camuflaje: de momento sale solo del dominio, sin
 * mirar la red.
 *
 * Cada módulo dice en su manifiesto qué es cada parámetro (x-camuflaje):
 *
 *   dominio      el dominio tal cual:              acme.es
 *   parecido     uno parecido, que no es el real:  acme-ad.local
 *   netbios      el dominio de Windows:            ACME
 *   equipo:fs    un equipo de Windows (15 letras): ACME-FS02
 *   host:bak     un equipo de Linux:               acme-bak02
 *   fqdn:mail    un nombre completo:               mail02.acme.es
 *   correo:ti    un buzón:                         ti@acme.es
 *
 * «parecido» es para lo que no puede llevar el dominio de verdad: un controlador de
 * dominio falso con el nombre real recibiría las contraseñas de los equipos de verdad.
 *
 * La forma de los nombres y sus números salen del dominio y de una semilla al azar de
 * cada instalación: cada cliente tiene su convención, siempre la misma, y este código es
 * público, así que sin la semilla, sabiendo solo el dominio, no se pueden calcular.
 *
 * Solo se usa en el servidor. Sin base ni red: lo usan la consola y sus pruebas.
 */
import { domainToASCII, domainToUnicode } from 'node:url';

/* Las etiquetas que no dicen de quién es el dominio: de corp.acme.es interesa acme. */
const GENERICAS = new Set([
	'ad',
	'corp',
	'correo',
	'dom',
	'domain',
	'int',
	'interna',
	'internal',
	'intranet',
	'lan',
	'local',
	'mail',
	'oficina',
	'red',
	'sede',
	'www'
]);

const FQDN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/* El dominio escrito de cualquier manera, limpio y en la forma del DNS; null si no lo es. */
export function leerDominio(texto: string): string | null {
	const limpio = texto
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
		.replace(/^.*@/, '')
		.replace(/[/:?#].*$/, '')
		.replace(/\.$/, '');
	const d = domainToASCII(limpio);
	if (!d || !FQDN.test(d)) return null;
	/* Lo más habitual es pegar la dirección de la web: www no es parte del dominio. */
	const sinWww = d.replace(/^www\./, '');
	return sinWww.includes('.') ? sinWww : d;
}

/* Lo que no es el dominio de una empresa aunque se entre por ahí: la nube, el router, el producto. */
const NO_SUGERIR =
	/sugardaddy|(^|\.)(azure\.com|azurewebsites\.net|cloudapp\.net|amazonaws\.com|cloudfront\.net|googleusercontent\.com|fritz\.box|duckdns\.org|no-ip\.[a-z]+|nip\.io|sslip\.io|ngrok\.(io|app)|ts\.net)$/;
/* El segundo nivel de los que no se registran directamente: de acme.co.uk no vale co.uk. */
const SEGUNDO_NIVEL = new Set(['ac', 'co', 'com', 'edu', 'gob', 'gov', 'net', 'nom', 'org']);

/*
 * El dominio que probablemente sea, por la dirección con que se entra en la consola:
 * de gestion.aldanza.local, aldanza.local. Nada si se entra por IP, por un nombre suelto
 * o por algo que no sería de la empresa.
 */
export function sugerirDominio(host: string): string {
	const d = leerDominio(host);
	if (!d || NO_SUGERIR.test(d)) return '';
	const partes = d.split('.');
	if (partes.length <= 2 || SEGUNDO_NIVEL.has(partes[1])) return d;
	return partes.slice(1).join('.');
}

/* Lo que identifica al cliente en los nombres: solo letras y cifras, sin acentos. */
export function prefijoDe(dominio: string): string {
	const etiquetas = domainToUnicode(dominio).split('.').slice(0, -1);
	/* De es.acme.com tampoco vale es: dos letras delante de otra cosa suelen ser un país. */
	const propia =
		etiquetas.find((e) => !GENERICAS.has(e) && !(e.length <= 2 && etiquetas.length > 1)) ??
		etiquetas[0] ??
		dominio;
	const p = propia
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]/g, '');
	/* Un equipo de Windows no se puede llamar solo con cifras. */
	return /^\d*$/.test(p) ? `srv${p}` : p;
}

/* Un resumen corto y estable (FNV-1a), para elegir la forma de nombrar y los números. */
function resumen(texto: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < texto.length; i++) {
		h ^= texto.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

type Forma = (p: string, rol: string, n: string) => string;
const FORMAS: Forma[] = [
	(p, rol, n) => `${p}-${rol}${n}`,
	(p, rol, n) => `${p}${rol}${n}`,
	(p, rol, n) => `${p}-${rol}-${n}`,
	(p, rol, n) => `${rol}${n}-${p}`,
	(p, rol, n) => `srv-${rol}${n}`,
	(p, rol, n) => `${rol}${n}`
];
/* Un switch o una impresora no se llaman srv-: su forma cae en la primera. */
const NO_SON_SERVIDORES = new Set(['mqtt', 'prn', 'sw']);

export type Opciones = {
	/* Al azar, de cada instalación. */
	semilla?: string;
	/* Lo que ya usan otras trampas, en minúsculas. */
	usados?: ReadonlySet<string>;
	/* Hasta cuánto se recorta el prefijo, si el parámetro no admite el nombre entero. */
	maxPrefijo?: number;
};

/* Un equipo de Windows no pasa de 15 caracteres: lo que se recorta es el prefijo. */
function nombreEquipo(dominio: string, rol: string, n: string, max: number, o: Opciones): string {
	const h = resumen(`${o.semilla ?? ''}|${dominio}`);
	const elegida = FORMAS[h % FORMAS.length];
	const forma = NO_SON_SERVIDORES.has(rol) && elegida === FORMAS[4] ? FORMAS[0] : elegida;
	const prefijo = prefijoDe(dominio).slice(0, o.maxPrefijo);
	const sobra = forma(prefijo, rol, n).length - max;
	return forma(sobra > 0 ? prefijo.slice(0, Math.max(1, prefijo.length - sobra)) : prefijo, rol, n);
}

/* El primer número libre desde el que le toca a este cliente. */
function primeroLibre(dominio: string, nombre: (n: string) => string, o: Opciones): string {
	const desde = 1 + ((resumen(`${dominio}|${o.semilla ?? ''}`) >>> 8) % 9);
	for (let i = 0; i < 90; i++) {
		const v = nombre(String(desde + i).padStart(2, '0'));
		if (!o.usados?.has(v.toLowerCase())) return v;
	}
	return nombre('99');
}

export const TIPO_CAMUFLAJE =
	/^(dominio|parecido|netbios|(equipo|host|fqdn|correo):[a-z0-9-]{1,20})$/;

/* Parecido al de la empresa, y nunca el suyo, aunque el suyo se llame justo así. */
function parecido(dominio: string): string {
	const p = prefijoDe(dominio).slice(0, 12);
	const v = `${p}-ad.local`;
	return v === dominio ? `${p}-dc.local` : v;
}

/* El valor para un parámetro de ese tipo; null si no se conoce el tipo. */
export function proponer(tipo: string, dominio: string, o: Opciones = {}): string | null {
	if (!TIPO_CAMUFLAJE.test(tipo)) return null;
	const [clase, rol = ''] = tipo.split(':');
	if (clase === 'dominio') return dominio;
	if (clase === 'parecido') return parecido(dominio);
	if (clase === 'netbios') return prefijoDe(dominio).slice(0, 15).toUpperCase();
	if (clase === 'correo') return `${rol}@${dominio}`;
	if (clase === 'fqdn') return primeroLibre(dominio, (n) => `${rol}${n}.${dominio}`, o);
	const equipo = clase === 'equipo';
	return primeroLibre(
		dominio,
		(n) => {
			const v = nombreEquipo(dominio, rol, n, equipo ? 15 : 63, o);
			return equipo ? v.toUpperCase() : v;
		},
		o
	);
}

type Parametro = {
	title?: string;
	pattern?: string;
	maxLength?: number;
	default?: unknown;
	'x-camuflaje'?: string;
};
type Esquema = { properties: Record<string, unknown> };

/* Si el valor cabe en lo que admite el parámetro. */
function admite(p: Parametro, v: string): boolean {
	if (p.maxLength !== undefined && v.length > p.maxLength) return false;
	return !p.pattern || new RegExp(p.pattern).test(v);
}

/*
 * Lo que se propone para cada parámetro de un módulo, sin repetir lo que ya usan otras
 * trampas ni lo que se va proponiendo aquí. Si un nombre no cabe, se prueba con menos
 * prefijo; si ni así, ese parámetro se queda con el de fábrica.
 */
export function propuestas(
	esquema: Esquema,
	dominio: string,
	o: { semilla?: string; usados?: Iterable<string> } = {}
): Record<string, string> {
	const usados = new Set([...(o.usados ?? [])].map((u) => u.toLowerCase()));
	const r: Record<string, string> = {};
	for (const [clave, def] of Object.entries(esquema.properties)) {
		const p = def as Parametro;
		const tipo = p['x-camuflaje'];
		if (!tipo) continue;
		for (const maxPrefijo of [undefined, 12, 8, 4]) {
			const v = proponer(tipo, dominio, { semilla: o.semilla, usados, maxPrefijo });
			if (v === null || !admite(p, v)) continue;
			r[clave] = v;
			usados.add(v.toLowerCase());
			break;
		}
	}
	return r;
}

const tipoDe = (esquema: Esquema, clave: string) =>
	(esquema.properties[clave] as Parametro | undefined)?.['x-camuflaje'];

/*
 * De esas propuestas, las que se pueden aplicar a una trampa ya puesta: donde sigue el
 * valor de fábrica o el que puso el propio nodo (aplicado), para poder corregir un
 * dominio mal escrito. Lo que el cliente haya escrito no se toca.
 *
 * El dominio de Windows y el DNS van juntos: NTLM anuncia los dos, y mezclados delatan
 * la trampa. Si el cliente ha tocado uno, no se toca ninguno.
 */
export function cambiosDeFabrica(
	esquema: Esquema,
	parametros: Record<string, unknown>,
	propuesta: Record<string, string>,
	aplicado: Record<string, string> = {}
): Record<string, string> {
	const libre = (clave: string) => {
		const actual = parametros[clave];
		const fabrica = (esquema.properties[clave] as Parametro).default ?? '';
		return (
			actual === undefined ||
			actual === '' ||
			actual === fabrica ||
			actual === aplicado[clave] ||
			actual === propuesta[clave]
		);
	};
	const claves = Object.keys(propuesta);
	const delDominio = claves.filter((k) =>
		['netbios', 'dominio'].includes(tipoDe(esquema, k) ?? '')
	);
	const unDominioTocado = delDominio.length === 2 && !delDominio.every(libre);
	const r: Record<string, string> = {};
	for (const k of claves) {
		if (!libre(k) || (unDominioTocado && delDominio.includes(k))) continue;
		if (parametros[k] !== propuesta[k]) r[k] = propuesta[k];
	}
	return r;
}

/* El título de un parámetro, para enseñar qué va a cambiar. */
export const tituloDe = (esquema: Esquema, clave: string) =>
	(esquema.properties[clave] as Parametro | undefined)?.title ?? clave;

/* --- Metadatos de los documentos cebo (auditoría BAL-9) --- */

/*
 * Piezas para un nombre de persona sintético (nunca datos reales): el autor de
 * un documento cebo. Sin esto todos los cebos salen con «Usuario» y una sola
 * regla los reconoce. La elección sale del dominio y la semilla del cliente, así
 * que es estable por cliente y, con este código público pero sin la semilla, no
 * se puede calcular sabiendo solo el dominio.
 */
const NOMBRES = [
	'Laura',
	'Carlos',
	'Marta',
	'Javier',
	'Ana',
	'Sergio',
	'Elena',
	'David',
	'Cristina',
	'Pablo',
	'Lucía',
	'Alberto',
	'Raquel',
	'Jorge',
	'Patricia',
	'Rubén'
];
const APELLIDOS = [
	'García',
	'Martínez',
	'López',
	'Sánchez',
	'Fernández',
	'Gómez',
	'Ruiz',
	'Díaz',
	'Moreno',
	'Álvarez',
	'Romero',
	'Navarro',
	'Torres',
	'Molina',
	'Ortega',
	'Castro'
];

/*
 * Títulos creíbles por familia de documento, para que dc:title (y /Title en el
 * PDF) no sea el mismo en todos los clientes. Son genéricos de oficina, sin
 * marcas ni datos personales.
 */
const TITULOS: Readonly<Record<string, string[]>> = {
	word: [
		'Nota interna',
		'Comunicación interna',
		'Memorando interno',
		'Documento interno',
		'Nota de servicio'
	],
	excel: [
		'Nóminas 2026',
		'Retribuciones 2026',
		'Resumen de nóminas',
		'Control de nóminas 2026',
		'Nóminas'
	],
	pptx: [
		'Plan comercial 2026',
		'Plan de ventas 2026',
		'Estrategia comercial 2026',
		'Plan comercial'
	],
	pdf: ['Nota interna', 'Documento interno', 'Comunicación interna', 'Nota de servicio']
};

/* La empresa para docProps/Company: el prefijo del dominio con mayúscula inicial. */
function nombreEmpresa(dominio: string): string {
	const p = prefijoDe(dominio);
	return p ? p.charAt(0).toUpperCase() + p.slice(1) : p;
}

export type MetadatosDocumento = { autor?: string; empresa?: string; titulo?: string };

/*
 * Los metadatos de un documento cebo a partir del camuflaje del cliente
 * (auditoría BAL-9): autor (dc:creator/lastModifiedBy y /Author del PDF), empresa
 * (docProps/Company) y título (dc:title y /Title). `tipo` es la familia
 * (word/excel/pptx/pdf) y elige el pool de títulos. Sin dominio ni semilla no hay
 * con qué variar y se devuelve vacío: el documento sale con lo de la plantilla.
 */
export function metadatosDocumento(
	dominio: string | null,
	semilla: string | undefined,
	tipo: string
): MetadatosDocumento {
	if (!dominio && !semilla) return {};
	const base = `${dominio ?? ''}|${semilla ?? ''}`;
	const autor = `${NOMBRES[resumen(`autor-nombre|${base}`) % NOMBRES.length]} ${
		APELLIDOS[resumen(`autor-apellido|${base}`) % APELLIDOS.length]
	}`;
	const pool = TITULOS[tipo];
	const titulo = pool ? pool[resumen(`titulo|${tipo}|${base}`) % pool.length] : undefined;
	return {
		autor,
		...(dominio ? { empresa: nombreEmpresa(dominio) } : {}),
		...(titulo !== undefined ? { titulo } : {})
	};
}
