import { CLAVE_HECHO } from './capacidades.ts';
import type { Capacidades, Hecho, Hechos, MotorSensor, ValorHecho } from './capacidades.ts';

/*
 * Los hechos de un destino (docs/diseno/modulo-despliegue.md §4): qué claves
 * conoce la consola, de dónde sale cada una y cómo se juntan. Lo que ve el
 * elector se calcula al leer, sin guardar copia:
 *
 *   fusionar(hechosDeFormulario(destino.descripcion), hechosDeConsola(sensor),
 *            hechosDeSensor(sensor.capacidades))
 *
 * Puro: sin base de datos ni reloj. El tipo Hecho es el de capacidades.ts.
 */

export type FuenteHecho = NonNullable<Hecho['fuente']>;
export type TipoHecho = 'texto' | 'version' | 'numero' | 'booleano' | 'lista';

/*
 * Cada campo del motor que manda el sensor (desde la 0.13.1) es un hecho
 * motor.<campo>. El Record obliga a que estén todos los de MotorSensor.
 */
const MOTOR: Record<keyof MotorSensor, TipoHecho> = {
	tipo: 'texto',
	modo: 'texto',
	version: 'version',
	api: 'version',
	apiMotor: 'version',
	apiMinima: 'version',
	sinGarantia: 'booleano',
	so: 'texto',
	arquitectura: 'texto',
	kernel: 'version',
	sistema: 'texto',
	cgroups: 'texto',
	cgroupDriver: 'texto',
	seguridad: 'lista',
	memoria: 'numero',
	cpus: 'numero',
	almacenamiento: 'texto',
	pasarelas: 'lista',
	puertaEnlace: 'texto',
	codigo: 'texto',
	error: 'texto'
};

/*
 * Catálogo de claves (§4.2): tipo y quién la puede dar. Una clave que no está
 * aquí se guarda igual (contrato abierto) y el comparador la compara si llega;
 * la consola solo la ignora en lo suyo.
 */
export const HECHOS: Record<string, { tipo: TipoHecho; fuentes: FuenteHecho[] }> = {
	'agente.version': { tipo: 'version', fuentes: ['consola'] },
	'agente.ejecutores': { tipo: 'lista', fuentes: ['sensor', 'consola'] },
	'agente.plataforma': { tipo: 'texto', fuentes: ['sensor'] },
	'registro.privado': { tipo: 'booleano', fuentes: ['consola'] },
	...Object.fromEntries(
		Object.entries(MOTOR).map(([campo, tipo]) => [
			`motor.${campo}`,
			{ tipo, fuentes: ['sensor'] as FuenteHecho[] }
		])
	),
	'motor.clone3': { tipo: 'booleano', fuentes: ['sensor'] },
	'red.ipOrigenReal': { tipo: 'booleano', fuentes: ['sensor'] },
	/*
	 * La sección red (docs/diseno/red.md): si la máquina puede dar a una
	 * trampa su propia IP en el segmento del cliente (macvlan sobre interfaz
	 * física por cable o VLAN). Wi-Fi y nube lo informan en false, con su
	 * motivo; sin él, el elector descarta las trampas «IP propia».
	 */
	'red.capa2': { tipo: 'booleano', fuentes: ['sensor'] },
	'puertos.ocupados': { tipo: 'lista', fuentes: ['sensor'] },
	'puertos.reservados': { tipo: 'lista', fuentes: ['consola'] },
	'red.direcciones': { tipo: 'lista', fuentes: ['sensor'] },
	'plataforma.so': { tipo: 'texto', fuentes: ['sensor', 'formulario'] },
	'plataforma.edicion': { tipo: 'texto', fuentes: ['formulario'] },
	'plataforma.version': { tipo: 'version', fuentes: ['formulario'] },
	'shell.powershell': { tipo: 'version', fuentes: ['formulario'] },
	'shell.posix': { tipo: 'texto', fuentes: ['formulario'] },
	'destino.direccion': { tipo: 'texto', fuentes: ['formulario'] },
	'fileserver.protocolos': { tipo: 'lista', fuentes: ['formulario'] },
	'recolector.canales': { tipo: 'lista', fuentes: ['sensor'] },
	'canal.rele': { tipo: 'booleano', fuentes: ['consola'] },
	/*
	 * Hasta dónde llega esta consola (ronda conectores-tanda1, §2.4): el
	 * webhook de H28/H29 y el ACS de H31 nacen en Internet y necesitan que
	 * el nodo atienda su dominio público. La consola la informa según sus
	 * ajustes; el elector la exige en las vías de nube.
	 */
	'alcance.consola': { tipo: 'texto', fuentes: ['consola'] },
	...Object.fromEntries(
		['graph', 'azure', 'aws', 'google', 'ldap'].map((c) => [
			`conexion.${c}.estado`,
			{ tipo: 'texto' as TipoHecho, fuentes: ['consola'] as FuenteHecho[] }
		])
	)
};

/*
 * Cómo se llama cada hecho para el cliente: en la ficha de un destino y en los
 * motivos del elector (§7.4), que no enseñan claves. Uno que no está aquí se
 * enseña con su clave (contrato abierto).
 */
export const NOMBRE_HECHO: Readonly<Record<string, string>> = Object.freeze({
	'agente.version': 'Versión del sensor',
	'agente.ejecutores': 'Qué sabe poner el sensor',
	'agente.plataforma': 'Plataforma del sensor',
	'registro.privado': 'Credencial del registro privado',
	'motor.tipo': 'Motor de contenedores',
	'motor.modo': 'Cómo corre el motor',
	'motor.version': 'Versión del motor',
	'motor.api': 'API del motor',
	'motor.so': 'Sistema que ve el motor',
	'motor.arquitectura': 'Arquitectura',
	'motor.sistema': 'Sistema',
	'motor.kernel': 'Núcleo',
	'motor.memoria': 'Memoria',
	'motor.cpus': 'Procesadores',
	'motor.codigo': 'Fallo del motor',
	'motor.error': 'Qué dice el fallo',
	'motor.clone3': 'Deja crear hilos (clone3)',
	'red.ipOrigenReal': 'Las trampas ven la IP real',
	'red.capa2': 'Puede poner a una trampa con IP propia',
	'puertos.ocupados': 'Puertos ya en uso',
	'puertos.reservados': 'Puertos reservados',
	'red.direcciones': 'Direcciones de la máquina',
	'plataforma.so': 'Sistema operativo',
	'plataforma.edicion': 'Edición',
	'plataforma.version': 'Versión del sistema',
	'shell.powershell': 'PowerShell',
	'shell.posix': 'Shell',
	'destino.direccion': 'Dirección',
	'fileserver.protocolos': 'Protocolos',
	'canal.rele': 'Recibe balizas (sensor con receptor)',
	'alcance.consola': 'Alcance de la consola (publica, privada o buzón)'
});

export const nombreHecho = (clave: string): string =>
	Object.hasOwn(NOMBRE_HECHO, clave) ? NOMBRE_HECHO[clave] : clave;

/* Los valores con nombre: el sistema y la edición como se eligen en el formulario, el modo del motor. */
const NOMBRE_VALOR: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	'plataforma.so': { windows: 'Windows', linux: 'Linux', macos: 'macOS', nas: 'NAS' },
	'plataforma.edicion': { servidor: 'Servidor', puesto: 'Puesto de trabajo' },
	'motor.modo': {
		rootful: 'con root',
		rootless: 'sin root',
		desktop: 'Docker Desktop',
		wsl: 'WSL2'
	},
	/* El alcance de la consola (ronda conectores-tanda1, §2.4), como se dice al cliente. */
	'alcance.consola': { publica: 'pública', privada: 'privada', buzon: 'de buzón' }
};

/* El valor de un hecho en texto: sí o no, una lista separada por comas. */
export function valorHecho(v: unknown): string {
	if (typeof v === 'boolean') return v ? 'sí' : 'no';
	if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(', ') : 'ninguno';
	return String(v);
}

/* Igual, con el nombre de los valores que lo tienen («Windows», no «windows»). */
export function valorVisible(clave: string, v: unknown): string {
	const nombres = Object.hasOwn(NOMBRE_VALOR, clave) ? NOMBRE_VALOR[clave] : undefined;
	if (nombres && typeof v === 'string' && Object.hasOwn(nombres, v)) return nombres[v];
	return valorHecho(v);
}

/* Para una misma clave: sensor > consola > formulario (§4.3). */
const RANGO: Record<FuenteHecho, number> = { formulario: 1, consola: 2, sensor: 3 };
const rango = (h: Hecho) => (h.fuente ? (RANGO[h.fuente] ?? 0) : 0);

/*
 * Junta varias capas de hechos. Gana la fuente de más rango, sea cual sea el
 * orden de las capas; con el mismo rango, la última. Una clave que no tiene la
 * forma del contrato (__proto__ incluida) no pasa.
 */
export function fusionar(...capas: Hechos[]): Hechos {
	const r: Hechos = {};
	for (const capa of capas)
		for (const [k, h] of Object.entries(capa)) {
			if (!CLAVE_HECHO.test(k)) continue;
			if (!Object.hasOwn(r, k) || rango(h) >= rango(r[k])) r[k] = h;
		}
	return r;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const esValor = (v: unknown): v is ValorHecho =>
	typeof v === 'boolean' ||
	typeof v === 'string' ||
	(typeof v === 'number' && Number.isFinite(v)) ||
	(Array.isArray(v) && v.every((x) => typeof x === 'string'));

/* Un valor del tipo que dice el catálogo. */
function cuadra(tipo: TipoHecho, v: unknown): v is ValorHecho {
	switch (tipo) {
		case 'texto':
		case 'version':
			return typeof v === 'string';
		case 'numero':
			return typeof v === 'number' && Number.isFinite(v);
		case 'booleano':
			return typeof v === 'boolean';
		case 'lista':
			return Array.isArray(v) && v.every((x) => typeof x === 'string');
	}
}

/* Los modos en que el motor ve el sistema de la máquina (§4.3). */
const MODOS_CON_SO = ['rootful', 'rootless'];

/*
 * Una clave del catálogo que no puede venir del sensor (puertos.reservados,
 * canal.rele, destino.direccion…): solo la sabe la consola o la dice el
 * cliente. canal.rele dice si este nodo puede recibir balizas (tiene un
 * sensor con un receptor de balizas colocado y comprobado), y lo decide la
 * consola, no el sensor. Si llegara del sensor, ganaría al fusionar (§4.3):
 * un sensor con fallos, o alguien con su token, quitaría la reserva del 443
 * o daría por alcanzable una señal que nunca llegará. Las claves que la consola no conoce
 * sí pasan: el contrato es abierto.
 */
const soloDeOtros = (k: string) =>
	Object.hasOwn(HECHOS, k) && !HECHOS[k].fuentes.includes('sensor');

/*
 * Lo que guardó la consola del último informe del sensor (sensores.capacidades:
 * {motor, hechos, cuando}, o null si no manda nada). El motor se aplana a
 * motor.<campo>; plataforma.so sale de motor.so solo con el motor en rootful o
 * rootless: con Docker Desktop o WSL el motor dice linux aunque la máquina sea
 * Windows o Mac, y ahí manda el formulario. Lo que manda el sensor como hecho
 * gana a lo que se deduce del motor, salvo las claves que el catálogo no le
 * deja dar.
 */
export function hechosDeSensor(c: (Capacidades & { cuando?: string }) | null | undefined): Hechos {
	if (!esObjeto(c)) return {};
	const marca: Pick<Hecho, 'fuente' | 'cuando'> = {
		fuente: 'sensor',
		...(typeof c.cuando === 'string' ? { cuando: c.cuando } : {})
	};
	const h: Hechos = {};
	const motor: Record<string, unknown> = esObjeto(c.motor) ? c.motor : {};
	for (const [campo, tipo] of Object.entries(MOTOR)) {
		const valor = motor[campo];
		if (cuadra(tipo, valor)) h[`motor.${campo}`] = { valor: structuredClone(valor), ...marca };
	}
	if (
		typeof motor.so === 'string' &&
		typeof motor.modo === 'string' &&
		MODOS_CON_SO.includes(motor.modo)
	)
		h['plataforma.so'] = { valor: motor.so, ...marca };
	if (esObjeto(c.hechos))
		for (const [k, x] of Object.entries(c.hechos)) {
			if (!CLAVE_HECHO.test(k) || soloDeOtros(k) || !esObjeto(x) || !esValor(x.valor)) continue;
			h[k] = {
				valor: structuredClone(x.valor),
				...(typeof x.motivo === 'string' ? { motivo: x.motivo } : {}),
				...marca
			};
		}
	return h;
}

/* Lo que la consola sabe de un sensor por su fila (sensores). */
export interface SensorDeConsola {
	id: string;
	/* sensores.version_agente: la cabecera Sugardaddy-Version de su último plan. */
	versionAgente?: string | null;
	/* sensores.registro_privado: si anuncia la credencial del registro. */
	registroPrivado?: boolean | null;
}

/* El sensor del propio nodo: su 443 es el de la consola. */
const SENSOR_LOCAL = 'local';

/*
 * Lo que pone la consola de un destino con sensor. agente.ejecutores va siempre
 * por defecto (contenedor@1, con motivo agente.anterior): un sensor que lo
 * informa gana al fusionar, y uno anterior sigue recibiendo sus trampas. Sin
 * sensor, nada.
 */
export function hechosDeConsola(sensor: SensorDeConsola | null | undefined): Hechos {
	if (!sensor) return {};
	const h: Hechos = {
		'agente.ejecutores': { valor: ['contenedor@1'], motivo: 'agente.anterior', fuente: 'consola' }
	};
	if (typeof sensor.versionAgente === 'string' && sensor.versionAgente !== '')
		h['agente.version'] = { valor: sensor.versionAgente, fuente: 'consola' };
	if (typeof sensor.registroPrivado === 'boolean')
		h['registro.privado'] = { valor: sensor.registroPrivado, fuente: 'consola' };
	if (sensor.id === SENSOR_LOCAL)
		h['puertos.reservados'] = { valor: ['tcp/443'], fuente: 'consola' };
	return h;
}

/*
 * Las respuestas del formulario corto de un destino (§5.2), tal como se guardan
 * en destinos.descripcion. Ningún sensor las pisa ni las borra (§4.3).
 */
export interface DescripcionDestino {
	so?: 'windows' | 'linux' | 'macos' | 'nas';
	edicion?: 'servidor' | 'puesto';
	/* Con puntos: 10.0.17763 (Windows, de una lista), 22.04 (Linux, a mano). */
	version?: string;
	/* 5.1, 7.4… */
	powershell?: string;
	posix?: 'bash' | 'sh' | 'busybox';
	/* IP o nombre. */
	direccion?: string;
	protocolos?: ('smb' | 'nfs')[];
	/*
	 * El texto libre de un destino «otro» (§5.1): qué es, para quien lo lea.
	 * No es un hecho: ningún requisito lo puede nombrar.
	 */
	nota?: string;
}

const DE_FORMULARIO: Record<
	Exclude<keyof DescripcionDestino, 'nota'>,
	{ clave: string; valores?: readonly string[] }
> = {
	so: { clave: 'plataforma.so', valores: ['windows', 'linux', 'macos', 'nas'] },
	edicion: { clave: 'plataforma.edicion', valores: ['servidor', 'puesto'] },
	version: { clave: 'plataforma.version' },
	powershell: { clave: 'shell.powershell' },
	posix: { clave: 'shell.posix', valores: ['bash', 'sh', 'busybox'] },
	direccion: { clave: 'destino.direccion' },
	protocolos: { clave: 'fileserver.protocolos', valores: ['smb', 'nfs'] }
};

/* Un nombre DNS cabe en 253 caracteres; un texto más largo no se recorta: se descarta. */
const MAX_TEXTO_FORMULARIO = 253;

/*
 * Las respuestas del formulario como hechos de §4.2 con fuente formulario. Se
 * lee con cuidado aunque lo escriba la propia consola: lo que no cuadra se
 * descarta.
 */
export function hechosDeFormulario(descripcion: unknown): Hechos {
	if (!esObjeto(descripcion)) return {};
	const h: Hechos = {};
	for (const [campo, { clave, valores }] of Object.entries(DE_FORMULARIO)) {
		const v = Object.hasOwn(descripcion, campo) ? descripcion[campo] : undefined;
		let valor: ValorHecho | undefined;
		if (Array.isArray(v)) {
			/* La única lista es protocolos: los que se conocen, sin repetir. */
			if (campo === 'protocolos')
				valor = [...new Set(v.filter((x): x is string => valores!.includes(x as string)))];
		} else if (typeof v === 'string' && campo !== 'protocolos') {
			const t = v.trim();
			if (valores ? valores.includes(t) : t.length > 0 && t.length <= MAX_TEXTO_FORMULARIO)
				valor = t;
		}
		if (valor !== undefined) h[clave] = { valor, fuente: 'formulario' };
	}
	return h;
}
