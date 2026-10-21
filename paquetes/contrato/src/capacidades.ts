/*
 * Lo que un sensor cuenta de su máquina al informar de su estado, desde la
 * 0.13.1: cómo es su motor de contenedores (o por qué no puede usarlo) y los
 * hechos que sabe, con espacio de nombres y su motivo (p. ej.
 * red.ipOrigenReal). Un sensor anterior no manda nada y una consola anterior
 * lo ignora.
 *
 * Lo escribe el sensor, pero se lee con cuidado: lo que no cuadra se
 * descarta y nunca hace fallar el informe del estado de las trampas.
 */

export interface MotorSensor {
	/* docker, podman u otro. */
	tipo?: string;
	/* rootful, rootless, desktop o wsl. */
	modo?: string;
	version?: string;
	/* La versión de la API con la que habla el sensor, y el tramo que admite el motor. */
	api?: string;
	apiMotor?: string;
	apiMinima?: string;
	/* El motor ya no admite ninguna versión de la API que conozca el sensor. */
	sinGarantia?: boolean;
	so?: string;
	arquitectura?: string;
	kernel?: string;
	sistema?: string;
	cgroups?: string;
	cgroupDriver?: string;
	seguridad?: string[];
	memoria?: number;
	cpus?: number;
	almacenamiento?: string;
	/* Las direcciones del motor en las redes de trampas. */
	pasarelas?: string[];
	/* Con WSL2, la puerta de enlace de su máquina virtual (en NAT, el propio Windows). */
	puertaEnlace?: string;
	/* Fallo general del motor: código estable (motor.*) y texto para el cliente. */
	codigo?: string;
	error?: string;
}

/* Un valor simple o una lista de textos (puertos.ocupados, agente.ejecutores…). */
export type ValorHecho = boolean | number | string | string[];

export interface Hecho {
	valor: ValorHecho;
	/* Código estable (fase.causa) de por qué se sabe. */
	motivo?: string;
	/*
	 * De dónde sale y cuándo se supo. Solo los pone la consola al juntar los
	 * hechos de un destino (hechos.ts); el sensor no los manda y leerHechos no
	 * los lee.
	 */
	fuente?: 'sensor' | 'consola' | 'formulario';
	cuando?: string;
}

export type Hechos = Record<string, Hecho>;

export interface Capacidades {
	motor: MotorSensor | null;
	hechos: Hechos;
}

/* Un código estable: fase.causa (motor.inalcanzable, origen.pasarela…). */
export const CODIGO = /^[a-z][a-z0-9-]*\.[a-z0-9-]+(\.[a-z0-9-]+)*$/;
/* Un hecho con espacio de nombres: red.ipOrigenReal, canal.panel… */
export const CLAVE_HECHO = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/;

const TEXTOS = [
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
] as const;

const esObjeto = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const texto = (v: unknown, max: number) =>
	typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;

const lista = (v: unknown, max: number) =>
	Array.isArray(v)
		? v
				.filter((x): x is string => typeof x === 'string' && x.length > 0)
				.slice(0, max)
				.map((x) => x.slice(0, 120))
		: undefined;

const numero = (v: unknown) =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;

function leerMotor(v: unknown): MotorSensor | null {
	if (!esObjeto(v)) return null;
	const m: MotorSensor = {};
	for (const k of TEXTOS) {
		const t = texto(v[k], 120);
		if (t) m[k] = t;
	}
	if (v.sinGarantia === true) m.sinGarantia = true;
	const seguridad = lista(v.seguridad, 16);
	if (seguridad?.length) m.seguridad = seguridad;
	const pasarelas = lista(v.pasarelas, 16);
	if (pasarelas?.length) m.pasarelas = pasarelas;
	const memoria = numero(v.memoria);
	if (memoria) m.memoria = memoria;
	const cpus = numero(v.cpus);
	if (cpus) m.cpus = cpus;
	if (typeof v.codigo === 'string' && CODIGO.test(v.codigo) && v.codigo.length <= 64) {
		m.codigo = v.codigo;
		m.error = texto(v.error, 400) ?? v.codigo;
	}
	return Object.keys(m).length ? m : null;
}

/*
 * Una lista de textos entera o nada: recortarla escondería, por ejemplo, un
 * puerto ocupado, y recortar un texto cambiaría su valor. Vacía vale (la sonda
 * no ha encontrado nada, que no es lo mismo que no saberlo).
 */
const MAX_LISTA = 512;
const MAX_ELEMENTO = 120;
const listaEntera = (v: unknown[]) =>
	v.length <= MAX_LISTA &&
	v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_ELEMENTO)
		? (v as string[]).slice()
		: undefined;

/*
 * Todos los hechos juntos caben en 32 KB (su JSON): sin tope, 32 listas de 512
 * textos de 120 caracteres serían 2 MB por informe, cada 10 s. Lo que de verdad
 * se manda (512 puertos, 64 direcciones) cabe de sobra. Un hecho que ya no
 * cabe se descarta entero, como una lista demasiado larga.
 */
const MAX_HECHOS_BYTES = 32 * 1024;
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;

function leerHechos(v: unknown): Hechos {
	const hechos: Hechos = {};
	if (!esObjeto(v)) return hechos;
	let ocupado = 0;
	for (const [k, h] of Object.entries(v).slice(0, 32)) {
		if (!CLAVE_HECHO.test(k) || k.length > 64 || !esObjeto(h)) continue;
		const valor =
			typeof h.valor === 'boolean' || (typeof h.valor === 'number' && Number.isFinite(h.valor))
				? h.valor
				: Array.isArray(h.valor)
					? listaEntera(h.valor)
					: texto(h.valor, 100);
		if (valor === undefined) continue;
		const motivo =
			typeof h.motivo === 'string' && CODIGO.test(h.motivo) && h.motivo.length <= 64
				? h.motivo
				: undefined;
		const hecho = motivo ? { valor, motivo } : { valor };
		const tamano = bytes(k) + bytes(hecho) + 2;
		if (ocupado + tamano > MAX_HECHOS_BYTES) continue;
		ocupado += tamano;
		hechos[k] = hecho;
	}
	return hechos;
}

/* Lee motor y hechos del cuerpo del informe de estado de un sensor. */
export function leerCapacidades(cuerpo: unknown): Capacidades {
	if (!esObjeto(cuerpo)) return { motor: null, hechos: {} };
	return { motor: leerMotor(cuerpo.motor), hechos: leerHechos(cuerpo.hechos) };
}
