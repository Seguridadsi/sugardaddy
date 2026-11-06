/*
 * El mapa del despliegue (página /mapa): qué se enseña de cada red, equipo y
 * trampa, y las cuentas que la página hace sin volver al servidor (buscar y
 * filtrar). Lo arma lib/server/mapa-despliegue-armar.ts con lo que ya sabe la consola.
 */
import type { ManifiestoTrampa } from '@sugardaddy/contrato';
import type { TipoDeServicio } from '@sugardaddy/estilo/pictogramas';
import type { Visible } from './server/colocacion';

/* Cómo llega a la consola lo que pasa en una trampa puesta fuera de un sensor. */
export interface RutaSenal {
	/* «Auditoría de Windows, hacia», «Quien use lo sembrado entra en»… */
	texto: string;
	/* La dirección a la que apunta (10.20.0.15:8088/tcp), si tiene una. */
	destino: string | null;
	rele: boolean;
}

export interface PuertoMapa {
	servicio: string;
	/* «22/tcp», «53/tcp+udp», «30100-30109/tcp». */
	puerto: string;
	/* La IP, si escucha en una concreta y no es la de su máquina. */
	escuchaEn: string | null;
}

export interface TrampaMapa {
	id: string;
	nombre: string;
	/* El nombre del módulo, si la trampa se llama de otra forma. */
	modulo: string | null;
	/* «Fichero», «Identidad»…: lo que se enseña como servicio si no publica puertos. */
	clase: string;
	estado: Visible;
	etiqueta: string;
	motivo: string | null;
	problema: boolean;
	eventos: number;
	puertos: PuertoMapa[];
	conIpPropia: boolean;
	ipPropia: string | null;
	/* Dónde está lo sembrado: una ruta, una carpeta o el nombre de una identidad. */
	ubicacion: string | null;
	ruta: RutaSenal | null;
	/* Los equipos o trampas cuya señal llega a esta. */
	recibeDe: string[];
	/* La trampa que recibe la señal de esta (el grafo las une), si es otra. */
	objetivo: string | null;
	/* De qué tipo es y de dónde sale: con esto se pinta su icono (LogoTrampa). */
	pictograma: TipoDeServicio | null;
	procedencia: ManifiestoTrampa['procedencia'] | null;
}

export type IconoEquipo = 'servidor' | 'ficheros' | 'maquina' | 'web' | 'nube';

/* Un sitio con trampas que no tiene sensor: un servidor, un NAS, una cuenta de nube. */
export interface SistemaMapa {
	id: string;
	nombre: string;
	tipo: string;
	icono: IconoEquipo;
	direccion: string | null;
	/* Su tipo lleva dirección y el cliente no la ha indicado. */
	faltaDireccion: boolean;
	plataforma: string | null;
	/* La ruta de sus trampas, si todas usan la misma; si no, cada una dice la suya. */
	ruta: RutaSenal | null;
	linea: 'senal' | 'rele';
	trampas: TrampaMapa[];
}

export interface SensorMapa {
	id: string;
	nombre: string;
	ip: string | null;
	otrasIps: string[];
	local: boolean;
	vivo: boolean;
	ultimoLatido: string | null;
	plataforma: string | null;
	motor: string | null;
	version: string | null;
	entorno: string | null;
	/* El destino de su máquina, para enlazar su ficha. */
	ficha: string | null;
	avisos: string[];
	trampas: TrampaMapa[];
	sistemas: SistemaMapa[];
}

export interface ZonaMapa {
	clave: string;
	/* red: sus sensores; fuera: lo que no está en la red del cliente; sin-senal: sistemas sin trampas. */
	tipo: 'red' | 'fuera' | 'sin-senal';
	nombre: string | null;
	red: string | null;
	vlan: number | null;
	/* El entorno de la red, si todos sus sensores tienen el mismo. */
	entorno: string | null;
	sensores: SensorMapa[];
	sistemas: SistemaMapa[];
	/* Si lo de fuera entra por el relé público. */
	rele: boolean;
}

export interface Mapa {
	consola: { ip: string | null; equipo: string | null; host: string | null; puerto: number };
	zonas: ZonaMapa[];
	resumen: {
		sensores: number;
		sensoresVivos: number;
		sistemas: number;
		trampas: number;
		porEstado: Partial<Record<Visible, number>>;
		/* Cómo se llaman los estados que hay, para la leyenda. */
		etiquetas: Partial<Record<Visible, string>>;
	};
}

/* ---- Direcciones ---- */

const octetos = (ip: string): number | null => {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return null;
	const o = m.slice(1).map(Number);
	if (o.some((x) => x > 255)) return null;
	return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
};

export const esIp = (texto: string) => octetos(texto) !== null;

export function enRed(ip: string, cidr: string): boolean {
	const [base, bits] = cidr.split('/');
	const n = octetos(ip);
	const b = octetos(base ?? '');
	const largo = Number(bits);
	if (n === null || b === null || !Number.isInteger(largo) || largo < 0 || largo > 32) return false;
	const mascara = largo === 0 ? 0 : (~0 << (32 - largo)) >>> 0;
	return (n & mascara) >>> 0 === (b & mascara) >>> 0;
}

export const esPrivada = (ip: string) =>
	['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].some((r) => enRed(ip, r));

/*
 * La IP con que se enseña una máquina, de las que cuenta su sensor: la que cae
 * en su red; si no se sabe la red, la primera privada; si no, la primera.
 */
export function ipPrincipal(ips: string[], red: string | null): string | null {
	const dentro = red ? ips.find((ip) => enRed(ip, red)) : undefined;
	return dentro ?? ips.find(esPrivada) ?? ips[0] ?? null;
}

/*
 * Lo que cuenta el sensor de una trampa en trampas.donde: «0.0.0.0:22,
 * 0.0.0.0:23» o «IP propia 10.20.0.240» (sensor/internal/despliegue). Cualquier
 * otra cosa («en espera: …», «error: …») no dice dónde escucha.
 */
export function leerDonde(donde: string): {
	ipPropia: string | null;
	enlaces: { ip: string; puerto: number }[];
} {
	const propia = /^IP propia (\S+)$/.exec(donde.trim());
	if (propia) return { ipPropia: propia[1], enlaces: [] };
	return {
		ipPropia: null,
		enlaces: donde.split(',').flatMap((x) => {
			const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(x.trim());
			return m ? [{ ip: m[1], puerto: Number(m[2]) }] : [];
		})
	};
}

/* ---- Textos ---- */

/* «A», «A y B», «A, B y 3 más». */
export function enumerar(nombres: string[], maximo = 3): string {
	if (nombres.length <= 1) return nombres[0] ?? '';
	if (nombres.length <= maximo)
		return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
	return `${nombres.slice(0, maximo).join(', ')} y ${nombres.length - maximo} más`;
}

const PLURALES: Record<Visible, [string, string]> = {
	comprobada: ['comprobada', 'comprobadas'],
	colocada: ['puesta, sin comprobar', 'puestas, sin comprobar'],
	'por-colocar': ['pendiente de poner', 'pendientes de poner'],
	degradada: ['degradada', 'degradadas'],
	'sin-contacto': ['sin contacto', 'sin contacto'],
	parada: ['parada', 'paradas'],
	retirando: ['retirándose', 'retirándose']
};
export const estadoEnPlural = (estado: Visible, n: number) => PLURALES[estado][n === 1 ? 0 : 1];

/* El orden en que se enseñan los estados: primero lo que requiere atención. */
export const ORDEN_ESTADOS: Visible[] = [
	'sin-contacto',
	'degradada',
	'por-colocar',
	'colocada',
	'comprobada',
	'parada',
	'retirando'
];

/* Cómo se llama cada grupo de trampas en el grafo: su tipo de servicio. */
export const FAMILIAS: Readonly<Record<TipoDeServicio, string>> = {
	'bases-de-datos': 'Bases de datos',
	ficheros: 'Ficheros',
	'escritorio-remoto': 'Escritorio remoto',
	terminal: 'Terminal',
	web: 'Web',
	'correo-electronico': 'Correo',
	red: 'Red',
	directorio: 'Directorio',
	contenedores: 'Contenedores',
	impresoras: 'Impresoras',
	camaras: 'Cámaras',
	iot: 'IoT',
	industria: 'Industria',
	sanidad: 'Sanidad',
	ia: 'IA',
	codigo: 'Código',
	retencion: 'Retención',
	nube: 'Nube'
};

/* El título de una red: su nombre o, si no lo tiene, su rango. */
export const tituloZona = (z: Pick<ZonaMapa, 'tipo' | 'nombre' | 'red'>) =>
	z.tipo === 'fuera'
		? 'Fuera de tu red'
		: z.tipo === 'sin-senal'
			? 'Sistemas sin trampas'
			: (z.nombre ?? z.red ?? 'Red sin indicar');

/*
 * Lo que dice una trampa en el grafo, debajo de su icono: su servicio y su
 * puerto o, si no publica ninguno, su clase y su nombre. El detalle, en su panel.
 */
export function etiquetaTrampa(t: TrampaMapa): {
	arriba: string;
	abajo: string;
	clase: 'puerto' | 'propia' | 'nombre';
} {
	if (t.conIpPropia)
		return { arriba: 'IP propia', abajo: t.ipPropia ?? 'Sin IP todavía', clase: 'propia' };
	if (!t.puertos.length) return { arriba: t.clase, abajo: t.nombre, clase: 'nombre' };
	const servicios = [...new Set(t.puertos.map((p) => p.servicio))];
	const arriba =
		servicios.length > 2
			? `${servicios.slice(0, 2).join(', ')} +${servicios.length - 2}`
			: servicios.join(', ');
	if (t.puertos.length === 1) return { arriba, abajo: t.puertos[0].puerto, clase: 'puerto' };
	/* «22, 23/tcp» si todos van por el mismo protocolo y caben; si no, el primero y cuántos más. */
	const partes = t.puertos.map((p) => p.puerto.split('/'));
	const mismo = partes.every((x) => x[1] === partes[0][1]);
	const juntos = `${partes.map((x) => x[0]).join(', ')}/${partes[0][1]}`;
	return {
		arriba,
		abajo:
			mismo && juntos.length <= 13 ? juntos : `${t.puertos[0].puerto} +${t.puertos.length - 1}`,
		clase: 'puerto'
	};
}

/* Lo que se enseña al pinchar en un nodo. */
export type DetalleNodo =
	| { tipo: 'sensor'; sensor: SensorMapa; zona: ZonaMapa }
	| { tipo: 'puerta'; zona: ZonaMapa }
	| { tipo: 'sistema'; sistema: SistemaMapa; recibe: SensorMapa | null }
	| { tipo: 'familia'; nombre: string; familia: TipoDeServicio | null; trampas: TrampaMapa[] }
	| { tipo: 'trampa'; trampa: TrampaMapa; equipo: string; ip: string | null };

/* De un id del grafo a lo que hay que enseñar; null si ya no está (se ha actualizado la página). */
export function detalleNodo(mapa: Mapa, id: string): DetalleNodo | null {
	for (const zona of mapa.zonas) {
		if (id === `c:zona:${zona.clave}`) return { tipo: 'puerta', zona };
		for (const y of zona.sistemas) {
			if (id === `s:${y.id}`) return { tipo: 'sistema', sistema: y, recibe: null };
			const t = y.trampas.find((x) => id === `t:${x.id}`);
			if (t) return { tipo: 'trampa', trampa: t, equipo: y.nombre, ip: y.direccion };
		}
		for (const sensor of zona.sensores) {
			if (id === `c:${sensor.id}`) return { tipo: 'sensor', sensor, zona };
			const propia = sensor.trampas.find((x) => id === `t:${x.id}`);
			if (propia) return { tipo: 'trampa', trampa: propia, equipo: sensor.nombre, ip: sensor.ip };
			const prefijo = `f:c:${sensor.id}:`;
			if (id.startsWith(prefijo)) {
				const clave = id.slice(prefijo.length);
				const familia = clave === 'null' ? null : (clave as TipoDeServicio);
				return {
					tipo: 'familia',
					familia,
					nombre: familia ? FAMILIAS[familia] : 'Otras',
					trampas: sensor.trampas.filter((x) => x.pictograma === familia)
				};
			}
			for (const y of sensor.sistemas) {
				if (id === `s:${y.id}`) return { tipo: 'sistema', sistema: y, recibe: sensor };
				const t = y.trampas.find((x) => id === `t:${x.id}`);
				if (t) return { tipo: 'trampa', trampa: t, equipo: y.nombre, ip: y.direccion };
			}
		}
	}
	return null;
}

/* ---- Buscar y filtrar ---- */

const normal = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const textoTrampa = (t: TrampaMapa) =>
	[
		t.nombre,
		t.modulo,
		t.clase,
		t.ubicacion,
		t.ipPropia,
		t.ruta?.destino,
		...t.puertos.flatMap((p) => [p.servicio, p.puerto, p.escuchaEn])
	]
		.filter(Boolean)
		.join(' ');

const textoSistema = (x: SistemaMapa) =>
	[x.nombre, x.tipo, x.direccion, x.plataforma].filter(Boolean).join(' ');
const textoSensor = (x: SensorMapa) =>
	[x.nombre, x.ip, ...x.otrasIps, x.plataforma, x.motor].filter(Boolean).join(' ');
const textoZona = (z: ZonaMapa) =>
	[tituloZona(z), z.red, z.vlan ? `VLAN ${z.vlan}` : null, z.entorno].filter(Boolean).join(' ');

export const sensorConProblema = (x: SensorMapa) => !x.vivo || x.ip === null;

/*
 * Lo que queda del mapa al buscar y al pedir solo lo que tiene problemas. Un
 * texto que coincide con una red o un equipo deja todo lo suyo; uno que
 * coincide con una trampa deja esa trampa y el equipo donde está, para que se
 * siga viendo su IP. El resumen no cambia: sigue diciendo lo que hay.
 */
export function filtrarMapa(mapa: Mapa, texto: string, soloProblemas: boolean): Mapa {
	const q = normal(texto.trim());
	if (!q && !soloProblemas) return mapa;
	const coincide = (t: string) => !q || normal(t).includes(q);
	const trampas = (ts: TrampaMapa[], heredado: boolean) =>
		ts.filter((t) => (!soloProblemas || t.problema) && (heredado || coincide(textoTrampa(t))));
	const sistemas = (xs: SistemaMapa[], heredado: boolean) =>
		xs.flatMap((x) => {
			const propio = heredado || (!!q && coincide(textoSistema(x)));
			const quedan = trampas(x.trampas, propio);
			const ella = propio && (!soloProblemas || x.faltaDireccion);
			const vacio = !q && !quedan.length && x.faltaDireccion;
			return quedan.length || ella || vacio ? [{ ...x, trampas: quedan }] : [];
		});
	const zonas = mapa.zonas.flatMap((z) => {
		const deZona = !!q && coincide(textoZona(z));
		const sensores = z.sensores.flatMap((x) => {
			const propio = deZona || (!!q && coincide(textoSensor(x)));
			const quedan = trampas(x.trampas, propio);
			const hijos = sistemas(x.sistemas, propio);
			const ella = propio && (!soloProblemas || sensorConProblema(x));
			const vacio = !q && sensorConProblema(x);
			return quedan.length || hijos.length || ella || vacio
				? [{ ...x, trampas: quedan, sistemas: hijos }]
				: [];
		});
		const sueltos = sistemas(z.sistemas, deZona);
		return sensores.length || sueltos.length ? [{ ...z, sensores, sistemas: sueltos }] : [];
	});
	return { ...mapa, zonas };
}
