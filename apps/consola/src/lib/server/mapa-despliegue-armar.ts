/*
 * El mapa del despliegue (página /mapa): las redes, los sensores, los sistemas
 * sin sensor y las trampas de cada uno. Una trampa sale donde está puesta (su
 * destino), no en el sensor que recibe su señal, y un sistema sin sensor cuelga
 * del sensor que recibe la mayoría de sus señales. Aquí solo se arma, sin tocar
 * la base, para poder probarlo entero: lo lee mapa-despliegue.ts.
 */
import { EJECUTORES, puertosPublicados, validarParametros, viaDe } from '@sugardaddy/contrato';
import type {
	CargaContenedor,
	Fuente,
	Honeycosa,
	Puerto,
	DescripcionDestino
} from '@sugardaddy/contrato';
import { camposDe, nombreTipoDestino } from '$lib/destinos';
import { ENTORNO_ETIQUETA, esEntorno } from '$lib/entorno';
import {
	enumerar,
	esIp,
	esPrivada,
	ipPrincipal,
	leerDonde,
	type IconoEquipo,
	type Mapa,
	type PuertoMapa,
	type RutaSenal,
	type SensorMapa,
	type SistemaMapa,
	type TrampaMapa,
	type ZonaMapa
} from '$lib/mapa-despliegue';
import { tipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import type { EstadoVisible, Visible } from './colocacion';

const LATIDO_MAXIMO = 5 * 60_000;

/* Lo que se enseña de cada estado como problema: «Solo con problemas» se queda con esto. */
const ESTADOS_PROBLEMA: readonly Visible[] = ['degradada', 'sin-contacto', 'por-colocar'];
/* Los tipos de destino que no están en la red del cliente. */
const TIPOS_FUERA = ['tenant', 'saas', 'paas-web', 'hosting'];

const ICONOS: Readonly<Record<string, IconoEquipo>> = {
	maquina: 'maquina',
	fileserver: 'ficheros',
	web: 'web',
	'paas-web': 'web',
	hosting: 'web',
	tenant: 'nube',
	saas: 'nube'
};

const CLASES: Readonly<Record<string, string>> = {
	contenedor: 'Contenedor',
	fichero: 'Fichero',
	token: 'Token',
	identidad: 'Identidad'
};

const CANALES: Readonly<Record<string, string>> = {
	'windows-eventos': 'Registros de Windows',
	syslog: 'Registros de syslog',
	journald: 'Registros de journald',
	'directorio-activo': 'Registros del directorio activo'
};

const CONEXIONES: Readonly<Record<string, string>> = {
	graph: 'Microsoft 365',
	azure: 'Azure',
	aws: 'AWS',
	google: 'Google',
	ldap: 'el directorio activo'
};

const CLASES_BALIZA: Readonly<Record<string, string>> = {
	documento: 'Baliza del documento, hacia',
	enlace: 'Baliza del enlace, hacia',
	webhook: 'Webhook de la nube, hacia',
	acs: 'Inicio de sesión SAML, hacia',
	vigia: 'Auditoría de Windows, hacia'
};

/*
 * El servicio de los puertos cuyo título no lo dice («Puerto de la consola»).
 * Los demás salen del título del parámetro («Puerto SSH» es SSH), así que una
 * trampa nueva no tiene que añadirse aquí para tener servicio.
 */
const SERVICIOS: Readonly<Record<string, string>> = {
	'almacen-s3:puertoApi': 'S3',
	'almacen-s3:puertoConsola': 'HTTP',
	'api-docker:puertoDocker': 'API Docker',
	'api-ia:puerto': 'HTTP',
	'api-interna:puerto': 'HTTP',
	'camara-ip:puertoWsd': 'WSD',
	'clima:puertoClima': 'BACnet',
	'consola-copias:puerto': 'HTTPS',
	'darknet:puertoSonda': 'Testigo',
	'elasticsearch:puerto': 'Elastic',
	'envenenador:puertoDetector': 'Detector',
	'envenenador:puertoEscucha': 'Escucha',
	'escaneo:': 'Testigo',
	'ftp:': 'FTP pasivo',
	'git:puertoGit': 'Git',
	'hipervisor:puertoWeb': 'HTTPS',
	'impresora:puertoRaw': 'JetDirect',
	'impresora:puertoWeb': 'HTTP',
	'login-web:puertoWeb': 'HTTP',
	'mcp:puertoMcp': 'MCP',
	'memcached:puertoMemcached': 'Memcached',
	'oracle:puertoOracle': 'Oracle',
	'plc-ab:puertoPlcAb': 'ENIP',
	'portal-vpn:puerto': 'HTTPS',
	'proxy-http:puertoProxy': 'Proxy',
	'receptor-balizas:puertoBaliza': 'HTTP',
	'retencion-ssh:puerto': 'SSH',
	'retencion-web:puerto': 'HTTP',
	'router-upnp:puertoHttp': 'HTTP',
	'sap:puertoSap': 'SAP',
	'svn:puertoSvn': 'SVN',
	'telecontrol:puertoIec104': 'IEC 104',
	'web-vulnerable:puertoWeb': 'HTTP',
	'webdav:puerto': 'WebDAV'
};

/* «Puerto SSH» → SSH; «Puerto MQTT (TCP)» → MQTT; «Puerto de la web» → web. */
export function servicioDelTitulo(titulo: string): string {
	return titulo
		.replace(/\(.*?\)/g, '')
		.replace(/^\s*Puerto(\s+del?(\s+la)?)?\s*/i, '')
		.trim();
}

export function servicioDePuerto(h: Honeycosa, p: Puerto): string {
	const propio = SERVICIOS[`${h.id}:${p.parametro ?? ''}`];
	if (propio) return propio;
	const esquema = p.parametro
		? (h.parametros.properties[p.parametro] as { title?: unknown })
		: null;
	const titulo = typeof esquema?.title === 'string' ? servicioDelTitulo(esquema.title) : '';
	return titulo || p.protocolo.toUpperCase();
}

/*
 * Los puertos de una trampa tal como se enseñan: mismo servicio y puerto en tcp
 * y udp, en una fila; los fijos seguidos (el FTP pasivo), como un rango. Lo que
 * dice el sensor manda en la IP: una trampa publicada en una dirección concreta
 * la enseña si no es la de su máquina.
 */
export function puertosParaMapa(
	h: Honeycosa,
	publicados: Puerto[],
	enlaces: { ip: string; puerto: number }[],
	ipMaquina: string | null
): PuertoMapa[] {
	const filas: { servicio: string; desde: number; hasta: number; protocolos: string[] }[] = [];
	for (const p of publicados) {
		const servicio = servicioDePuerto(h, p);
		const ultima = filas[filas.length - 1];
		const mismo = filas.find(
			(f) => f.servicio === servicio && f.desde === p.puerto && f.hasta === p.puerto
		);
		if (mismo) {
			if (!mismo.protocolos.includes(p.protocolo)) mismo.protocolos.push(p.protocolo);
		} else if (
			p.fijo &&
			ultima?.servicio === servicio &&
			ultima.hasta + 1 === p.puerto &&
			ultima.protocolos.join() === p.protocolo
		)
			ultima.hasta = p.puerto;
		else filas.push({ servicio, desde: p.puerto, hasta: p.puerto, protocolos: [p.protocolo] });
	}
	return filas.map((f) => {
		const ips = enlaces.filter((e) => e.puerto === f.desde).map((e) => e.ip);
		const concreta = ips.find((ip) => ip !== '0.0.0.0' && ip !== ipMaquina) ?? null;
		const rango = f.desde === f.hasta ? `${f.desde}` : `${f.desde}-${f.hasta}`;
		return {
			servicio: f.servicio,
			puerto: `${rango}/${f.protocolos.join('+')}`,
			escuchaEn: concreta
		};
	});
}

const unir = (carpeta: string, fichero: string) => {
	if (carpeta.endsWith(fichero)) return carpeta;
	if (/[\\/]$/.test(carpeta)) return carpeta + fichero;
	return `${carpeta}${carpeta.includes('\\') ? '\\' : '/'}${fichero}`;
};

/*
 * Dónde está lo sembrado, de sus parámetros. Lista cerrada a propósito: lo demás
 * (contraseñas, claves, marcas) no sale de la ficha de la trampa.
 */
export function ubicacionDe(parametros: Record<string, unknown>): string | null {
	const texto = (k: string) => {
		const v = parametros[k];
		return typeof v === 'string' && v.trim() ? v.trim() : null;
	};
	const carpetas = parametros.carpetas;
	if (Array.isArray(carpetas)) {
		const lista = carpetas.filter((x): x is string => typeof x === 'string' && !!x.trim());
		if (lista.length) return enumerar(lista);
	}
	const ruta = texto('ruta') ?? texto('carpetas');
	const fichero = texto('fichero') ?? texto('nombreFichero');
	if (ruta && fichero) return unir(ruta, fichero);
	return ruta ?? fichero ?? texto('nombreApp') ?? texto('nombre');
}

/* La dirección de una baliza, o el relé si va por él. */
export function destinoDeUrl(
	url: string,
	rele: string | null
): { destino: string; rele: boolean } | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	const dominio = rele?.replace(/^https?:\/\//, '').split('/')[0];
	if (dominio && u.host.toLowerCase() === dominio.toLowerCase())
		return { destino: 'relé público', rele: true };
	return {
		destino: `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}/tcp`,
		rele: false
	};
}

export function esFuera(tipo: string, direccion: string | null): boolean {
	if (TIPOS_FUERA.includes(tipo)) return true;
	return !!direccion && esIp(direccion) && !esPrivada(direccion);
}

/* Host y puerto por los que la consola recibe a sus sensores (env.ORIGIN) o, sin él, a quien mira. */
export function origenDe(origin: string | undefined, url: URL) {
	let u = url;
	try {
		if (origin) u = new URL(origin);
	} catch {
		/* Un ORIGIN que no se entiende no rompe el mapa: se usa la dirección de la petición. */
	}
	return {
		host: u.hostname.replace(/^\[|\]$/g, ''),
		puerto: u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443
	};
}

/* ---- Lo que entra ---- */

export interface SensorEntrada {
	id: string;
	nombre: string;
	red: string | null;
	redNombre: string | null;
	vlan: number | null;
	entorno: string | null;
	remoto: boolean;
	version: string | null;
	versionAgente: string | null;
	ultimoLatido: Date | null;
	ips: string[];
	plataforma: string | null;
	motor: string | null;
	avisos: string[];
}

export interface DestinoEntrada {
	id: string;
	nombre: string;
	tipo: string;
	sensor: string | null;
	descripcion: DescripcionDestino;
	activo: boolean;
	plataforma: string | null;
}

export interface TrampaEntrada {
	id: string;
	nombre: string;
	modulo: string;
	tipo: string;
	sensor: string;
	destino: string | null;
	via: string;
	parametros: Record<string, unknown>;
	donde: string;
	senalTrampa: string | null;
	eventos: number;
}

export interface BalizaEntrada {
	trampa: string;
	clase: string;
	url: string;
	receptor: string | null;
}

export interface EntradaMapa {
	ahora: number;
	origen: { host: string; puerto: number };
	sensores: SensorEntrada[];
	destinos: DestinoEntrada[];
	trampas: TrampaEntrada[];
	balizas: BalizaEntrada[];
	estados: Map<string, EstadoVisible>;
	catalogo: Map<string, Honeycosa>;
	/* El ajuste «rele»: el dominio del relé público, si este nodo lo tiene. */
	rele: string | null;
}

/* ---- Armar ---- */

function puertosDe(t: TrampaEntrada, h: Honeycosa | undefined): Puerto[] {
	const v = h && viaDe(h, t.via);
	if (!h || !v || v.ejecutor !== 'contenedor@1') return [];
	const p = validarParametros(h.parametros, t.parametros);
	return puertosPublicados(v.carga as CargaContenedor, p.ok ? p.valor : t.parametros);
}

const conIpPropiaDe = (t: TrampaEntrada, h: Honeycosa | undefined) => {
	const v = h && viaDe(h, t.via);
	return !!v && v.ejecutor === 'contenedor@1' && !!(v.carga as CargaContenedor).red;
};

const mismaRuta = (a: RutaSenal | null, b: RutaSenal | null) =>
	a?.texto === b?.texto && a?.destino === b?.destino;

function ordenar(ts: TrampaMapa[]) {
	return ts.toSorted(
		(a, b) =>
			Number(b.problema) - Number(a.problema) ||
			b.eventos - a.eventos ||
			a.nombre.localeCompare(b.nombre, 'es')
	);
}

export function armarMapa(e: EntradaMapa): Mapa {
	const sensorDe = new Map(e.sensores.map((x) => [x.id, x]));
	const destinoDe = new Map(e.destinos.map((d) => [d.id, d]));
	const trampaDe = new Map(e.trampas.map((t) => [t.id, t]));
	const balizaDe = new Map(e.balizas.map((b) => [b.trampa, b]));
	const ipDe = new Map(e.sensores.map((x) => [x.id, ipPrincipal(x.ips, x.red)]));
	const destinoDelSensor = new Map(e.destinos.flatMap((d) => (d.sensor ? [[d.sensor, d]] : [])));

	/* De quién recibe señal cada trampa: el receptor de una baliza, la trampa objetivo. */
	const recibeDe = new Map<string, string[]>();
	const apuntar = (objetivo: string | null, t: TrampaEntrada) => {
		if (!objetivo) return;
		const d = t.destino ? destinoDe.get(t.destino) : null;
		const quien = d && !d.sensor ? d.nombre : t.nombre;
		const lista = recibeDe.get(objetivo) ?? [];
		if (!lista.includes(quien)) lista.push(quien);
		recibeDe.set(objetivo, lista);
	};
	for (const t of e.trampas) apuntar(balizaDe.get(t.id)?.receptor ?? t.senalTrampa, t);

	/* La primera dirección y puerto de una trampa objetivo: «10.30.0.21:22/tcp». */
	const direccionDe = (t: TrampaEntrada): string | null => {
		const h = e.catalogo.get(t.modulo);
		const { ipPropia, enlaces } = leerDonde(t.donde);
		if (ipPropia) return ipPropia;
		const ip = ipDe.get(t.sensor) ?? null;
		const [p] = h ? puertosParaMapa(h, puertosDe(t, h), enlaces, ip) : [];
		const donde = p?.escuchaEn ?? ip;
		return donde && p ? `${donde}:${p.puerto}` : (donde ?? p?.puerto ?? null);
	};

	const rutaDe = (t: TrampaEntrada, fuente: Fuente | undefined): RutaSenal | null => {
		if (!fuente || fuente.tipo === 'fichero') return null;
		if (fuente.tipo === 'trampa') {
			const objetivo = t.senalTrampa ? trampaDe.get(t.senalTrampa) : null;
			return objetivo
				? {
						texto: 'Quien use lo sembrado entra en',
						destino: direccionDe(objetivo) ?? objetivo.nombre,
						rele: false
					}
				: { texto: 'Sin trampa que reciba su señal', destino: null, rele: false };
		}
		if (fuente.tipo === 'registros') {
			const sensor = sensorDe.get(t.sensor)?.nombre;
			const canal = CANALES[fuente.canal] ?? 'Registros del sistema';
			return {
				texto: sensor ? `${canal}, leídos por ${sensor}` : canal,
				destino: null,
				rele: false
			};
		}
		if (fuente.tipo === 'conector')
			return {
				texto: `La consola consulta ${CONEXIONES[fuente.conexion] ?? fuente.conexion}`,
				destino: null,
				rele: false
			};
		const b = balizaDe.get(t.id);
		const destino = b ? destinoDeUrl(b.url, e.rele) : null;
		if (!b || !destino) return { texto: 'Baliza sin dirección', destino: null, rele: false };
		return {
			texto: CLASES_BALIZA[b.clase] ?? 'Baliza, hacia',
			destino: destino.destino,
			rele: destino.rele
		};
	};

	const trampaMapa = (t: TrampaEntrada): TrampaMapa | null => {
		const estado = e.estados.get(t.id);
		if (!estado) return null;
		const h = e.catalogo.get(t.modulo);
		const v = h ? viaDe(h, t.via) : undefined;
		const { ipPropia, enlaces } = leerDonde(t.donde);
		const conIpPropia = conIpPropiaDe(t, h);
		const manual = !!v && EJECUTORES[v.ejecutor]?.corre === 'consola';
		return {
			id: t.id,
			nombre: t.nombre,
			modulo: h && h.nombre !== t.nombre ? h.nombre : null,
			clase: CLASES[t.tipo] ?? t.tipo,
			estado: estado.estado,
			etiqueta: estado.etiqueta,
			motivo: estado.motivo,
			problema: ESTADOS_PROBLEMA.includes(estado.estado),
			eventos: t.eventos,
			puertos:
				h && !conIpPropia
					? puertosParaMapa(h, puertosDe(t, h), enlaces, ipDe.get(t.sensor) ?? null)
					: [],
			conIpPropia,
			ipPropia,
			ubicacion: manual ? ubicacionDe(t.parametros) : null,
			ruta: rutaDe(t, v?.senal.fuente),
			recibeDe: recibeDe.get(t.id) ?? [],
			objetivo: balizaDe.get(t.id)?.receptor ?? t.senalTrampa,
			pictograma: tipoDeServicio(t.modulo),
			procedencia: h?.procedencia ?? null
		};
	};

	/* Dónde se enseña cada trampa: en su destino o, sin él, en la máquina de su sensor. */
	const enSensor = new Map<string, TrampaEntrada[]>();
	const enSistema = new Map<string, TrampaEntrada[]>();
	for (const t of e.trampas) {
		const d = t.destino ? destinoDe.get(t.destino) : undefined;
		if (d && !d.sensor) enSistema.set(d.id, [...(enSistema.get(d.id) ?? []), t]);
		else {
			const id = d?.sensor ?? t.sensor;
			enSensor.set(id, [...(enSensor.get(id) ?? []), t]);
		}
	}

	const sensorMapa = (x: SensorEntrada): SensorMapa => {
		const ip = ipDe.get(x.id) ?? null;
		return {
			id: x.id,
			nombre: x.nombre,
			ip,
			otrasIps: x.ips.filter((i) => i !== ip),
			local: !x.remoto,
			vivo: !!x.ultimoLatido && e.ahora - x.ultimoLatido.getTime() < LATIDO_MAXIMO,
			ultimoLatido: x.ultimoLatido?.toISOString() ?? null,
			plataforma: x.plataforma,
			motor: x.motor,
			version: x.versionAgente ?? x.version,
			entorno: esEntorno(x.entorno) ? ENTORNO_ETIQUETA[x.entorno] : null,
			ficha: destinoDelSensor.get(x.id)?.id ?? null,
			avisos: x.avisos,
			trampas: ordenar((enSensor.get(x.id) ?? []).flatMap((t) => trampaMapa(t) ?? [])),
			sistemas: []
		};
	};

	/* Los sensores, por red. Local primero: es donde está la consola. */
	const ordenados = e.sensores.toSorted((a, b) => Number(a.remoto) - Number(b.remoto));
	const sensores = new Map(ordenados.map((x) => [x.id, sensorMapa(x)]));
	const zonas = new Map<string, ZonaMapa>();
	for (const x of ordenados) {
		const clave = `red|${x.redNombre ?? ''}|${x.red ?? ''}|${x.vlan ?? ''}`;
		const z = zonas.get(clave) ?? {
			clave,
			tipo: 'red' as const,
			nombre: x.redNombre,
			red: x.red,
			vlan: x.vlan,
			entorno: null,
			sensores: [],
			sistemas: [],
			rele: false
		};
		z.sensores.push(sensores.get(x.id)!);
		zonas.set(clave, z);
	}
	for (const z of zonas.values()) {
		const [primero, ...resto] = z.sensores;
		z.entorno = resto.every((x) => x.entorno === primero?.entorno)
			? (primero?.entorno ?? null)
			: null;
	}

	/* Los sistemas sin sensor: fuera de la red, colgando de un sensor o sin trampas todavía. */
	const fuera: SistemaMapa[] = [];
	const sueltos: SistemaMapa[] = [];
	for (const d of e.destinos) {
		if (d.sensor) continue;
		const suyas = enSistema.get(d.id) ?? [];
		if (!d.activo && !suyas.length) continue;
		const trampas = ordenar(suyas.flatMap((t) => trampaMapa(t) ?? []));
		const direccion = d.descripcion.direccion?.trim() || null;
		const ruta = trampas[0]?.ruta ?? null;
		const comun = trampas.every((t) => mismaRuta(t.ruta, ruta));
		const deFuera = esFuera(d.tipo, direccion);
		const sistema: SistemaMapa = {
			id: d.id,
			nombre: d.nombre,
			tipo: nombreTipoDestino(d.tipo),
			icono: ICONOS[d.tipo] ?? 'servidor',
			direccion,
			faltaDireccion: !direccion && camposDe(d.tipo).includes('direccion'),
			plataforma: d.plataforma,
			ruta: comun ? ruta : null,
			linea: deFuera || (trampas.length && trampas.every((t) => t.ruta?.rele)) ? 'rele' : 'senal',
			trampas
		};
		if (deFuera) fuera.push(sistema);
		else if (!suyas.length) sueltos.push(sistema);
		else {
			/* Del sensor que recibe la mayoría de sus señales; a igualdad, el primero. */
			const cuenta = new Map<string, number>();
			for (const t of suyas) cuenta.set(t.sensor, (cuenta.get(t.sensor) ?? 0) + 1);
			const [padre] = [...cuenta].toSorted((a, b) => b[1] - a[1])[0] ?? [];
			const sensor = padre ? sensores.get(padre) : undefined;
			if (sensor) sensor.sistemas.push(sistema);
			else sueltos.push(sistema);
		}
	}

	const lista = [...zonas.values()];
	if (fuera.length)
		lista.push({
			clave: 'fuera',
			tipo: 'fuera',
			nombre: null,
			red: null,
			vlan: null,
			entorno: null,
			sensores: [],
			sistemas: fuera,
			rele: fuera.some((x) => x.trampas.some((t) => t.ruta?.rele))
		});
	if (sueltos.length)
		lista.push({
			clave: 'sin-senal',
			tipo: 'sin-senal',
			nombre: null,
			red: null,
			vlan: null,
			entorno: null,
			sensores: [],
			sistemas: sueltos,
			rele: false
		});

	const local = ordenados.find((x) => !x.remoto);
	const todas = [...sensores.values()].flatMap((x) => [
		...x.trampas,
		...x.sistemas.flatMap((y) => y.trampas)
	]);
	const todasConFuera = [...todas, ...fuera.flatMap((x) => x.trampas)];
	const porEstado: Mapa['resumen']['porEstado'] = {};
	const etiquetas: Mapa['resumen']['etiquetas'] = {};
	for (const t of todasConFuera) {
		porEstado[t.estado] = (porEstado[t.estado] ?? 0) + 1;
		etiquetas[t.estado] = t.etiqueta;
	}

	return {
		consola: {
			ip: (local && ipDe.get(local.id)) ?? (esIp(e.origen.host) ? e.origen.host : null),
			equipo: local?.nombre ?? null,
			host: esIp(e.origen.host) ? null : e.origen.host,
			puerto: e.origen.puerto
		},
		zonas: lista,
		resumen: {
			sensores: sensores.size,
			sensoresVivos: [...sensores.values()].filter((x) => x.vivo).length,
			sistemas:
				fuera.length +
				sueltos.length +
				[...sensores.values()].reduce((n, x) => n + x.sistemas.length, 0),
			trampas: todasConFuera.length,
			porEstado,
			etiquetas
		}
	};
}
