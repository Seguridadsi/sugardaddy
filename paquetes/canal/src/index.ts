/*
 * El canal entre cada nodo y el panel central.
 *
 * Toda conexión la abre el nodo. Dos direcciones, dos firmas Ed25519:
 *
 * - SUBIDA. El nodo firma cada petición con su clave privada, que nunca sale
 *   de él. El panel solo guarda la clave pública: si alguien roba la base de
 *   datos del panel, no puede hacerse pasar por ningún nodo.
 *
 * - BAJADA. El panel firma el estado deseado de cada cliente. El nodo fijó la
 *   clave pública del panel al darse de alta y rechaza todo lo que no venga
 *   firmado con ella, esté caducado o sea para otro cliente. En producción esa
 *   clave vive en un HSM, fuera del panel: tomar el panel no basta para mandar
 *   órdenes a los nodos.
 */
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
	type KeyObject
} from 'node:crypto';
import type { LicenciaFirmada } from './licencia.ts';

export type ParDeClaves = { privada: string; publica: string };

/* Claves en DER base64 (pkcs8 / spki): texto, fácil de guardar en .env o en una fila. */
export function generarClaves(): ParDeClaves {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	return {
		privada: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
		publica: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
	};
}

const privada = (b64: string) =>
	createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
const publica = (b64: string) =>
	createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

/* Huella corta de una clave pública, para enseñarla y compararla a ojo. */
export const huella = (publicaB64: string) =>
	createHash('sha256').update(Buffer.from(publicaB64, 'base64')).digest('hex').slice(0, 16);

/* ---------- subida: peticiones firmadas por el nodo ---------- */

export const MARGEN_RELOJ_MS = 5 * 60_000;

function canonica(metodo: string, ruta: string, fecha: string, cuerpo: string) {
	const h = createHash('sha256').update(cuerpo).digest('hex');
	return `${metodo.toUpperCase()}\n${ruta}\n${fecha}\n${h}`;
}

export function firmarPeticion(
	clavePrivada: string,
	nodo: string,
	metodo: string,
	ruta: string,
	cuerpo: string,
	ahora = Date.now()
): Record<string, string> {
	const fecha = new Date(ahora).toISOString();
	const firma = sign(
		null,
		Buffer.from(canonica(metodo, ruta, fecha, cuerpo)),
		privada(clavePrivada)
	);
	return { 'x-nodo': nodo, 'x-fecha': fecha, 'x-firma': firma.toString('base64') };
}

export type Verificacion = { ok: true } | { ok: false; motivo: string };

/*
 * Firma, reloj y repetición. `vistas` guarda las firmas aceptadas dentro del
 * margen de reloj: la misma petición no vale dos veces.
 */
export function verificarPeticion(
	clavePublica: string,
	cabeceras: { fecha: string | null; firma: string | null },
	metodo: string,
	ruta: string,
	cuerpo: string,
	vistas: Map<string, number>,
	ahora = Date.now()
): Verificacion {
	const { fecha, firma } = cabeceras;
	if (!fecha || !firma) return { ok: false, motivo: 'faltan cabeceras de firma' };
	const t = Date.parse(fecha);
	if (!Number.isFinite(t) || Math.abs(ahora - t) > MARGEN_RELOJ_MS)
		return { ok: false, motivo: 'fecha fuera de margen' };
	let valida = false;
	try {
		valida = verify(
			null,
			Buffer.from(canonica(metodo, ruta, fecha, cuerpo)),
			publica(clavePublica),
			Buffer.from(firma, 'base64')
		);
	} catch {
		valida = false;
	}
	if (!valida) return { ok: false, motivo: 'firma no válida' };

	for (const [f, cuando] of vistas) if (ahora - cuando > 2 * MARGEN_RELOJ_MS) vistas.delete(f);
	if (vistas.has(firma)) return { ok: false, motivo: 'petición repetida' };
	vistas.set(firma, ahora);
	return { ok: true };
}

/* ---------- bajada: estado deseado firmado por el panel ---------- */

export type EstadoDeseado = {
	version: 1;
	cliente: string;
	/* Versión de Sugardaddy que debería tener el nodo. */
	versionObjetivo: string;
	/*
	 * La versión objetivo, firmada con la clave de publicación (no con la del
	 * panel). Nulo si el nodo ya la tiene o si no hay ninguna que darle.
	 */
	release: ReleaseFirmada | null;
	anillo: 'laboratorio' | 'piloto' | 'general';
	despliegueEnPausa: boolean;
	/*
	 * Petición de acceso de soporte pendiente, si la hay. Viaja firmada para
	 * que nadie más que el panel pueda pedir acceso a un nodo. Abrirlo lo
	 * decide siempre el cliente, en su consola.
	 */
	soporte: SolicitudSoporte | null;
	/* Módulos de trampa que este cliente tiene autorizados. El nodo no ofrece ni despliega ningún otro. */
	modulos: string[];
	/*
	 * Licencia de pago firmada con la clave de PUBLICACIÓN (no con la del panel),
	 * que el nodo guarda y el sensor pasa a cada trampa de pago para que la
	 * compruebe al arrancar (docs/diseno/licencias-de-pago.md). No es secreta: es
	 * un permiso firmado. Opcional: un nodo de edición gratis no la lleva, y los
	 * paneles/nodos 0.12-0.15 la ignoran. Nula si el cliente no tiene ninguna.
	 */
	licencia?: LicenciaFirmada | null;
	/*
	 * sha256 del logotipo del cliente, o nulo. El nodo lo pide aparte cuando
	 * cambia y comprueba que coincide: así viaja firmado sin engordar cada latido.
	 * Opcional porque los paneles anteriores a la 0.11 no lo mandan.
	 */
	logo?: string | null;
	/* sha256 de la lista firmada de nodos de salida de Tor; el nodo la pide aparte cuando cambia. */
	tor?: string | null;
	emitido: string;
	caduca: string;
};

export type SolicitudSoporte = { por: string; motivo: string; cuando: string };

export type EstadoFirmado = { estado: string; firma: string };

/*
 * Se firma el texto exacto del estado, no un objeto: lo que verifica el nodo
 * es lo que firmó el panel, sin depender de cómo se serialice.
 */
export function firmarEstado(clavePrivada: string, estado: EstadoDeseado): EstadoFirmado {
	const texto = JSON.stringify(estado);
	return {
		estado: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64')
	};
}

export function verificarEstado(
	clavePublicaPanel: string,
	cliente: string,
	f: EstadoFirmado,
	ahora = Date.now()
): { ok: true; estado: EstadoDeseado } | { ok: false; motivo: string } {
	let valida = false;
	try {
		valida = verify(
			null,
			Buffer.from(f.estado),
			publica(clavePublicaPanel),
			Buffer.from(f.firma, 'base64')
		);
	} catch {
		valida = false;
	}
	if (!valida) return { ok: false, motivo: 'firma del panel no válida' };
	const e = JSON.parse(f.estado) as EstadoDeseado;
	if (e.version !== 1) return { ok: false, motivo: 'versión de estado desconocida' };
	if (e.cliente !== cliente) return { ok: false, motivo: 'el estado es para otro cliente' };
	if (Date.parse(e.caduca) < ahora) return { ok: false, motivo: 'estado caducado' };
	return { ok: true, estado: e };
}

/* ---------- versiones publicadas ---------- */

/*
 * Una versión de Sugardaddy: qué imagen, por digest, lleva cada servicio del
 * nodo. La firma la clave de publicación de SeguridadSI, que no vive en el
 * panel: el panel solo reparte versiones ya firmadas. Así, quien tome el
 * panel puede como mucho elegir entre versiones auténticas, y el nodo además
 * rechaza bajar de versión.
 */
export type Release = {
	version: string;
	publicada: string;
	notas: string;
	servicios: Record<string, string>;
	/* Imagen del actualizador: también la del auxiliar que aplica la configuración. */
	actualizador?: string;
	/*
	 * Configuración del nodo y del sensor remoto que viaja firmada con la
	 * versión: los ficheros de compose (y el Caddyfile del nodo) y las
	 * variables nuevas de .env. Así una actualización cambia montajes,
	 * variables o servicios sin que nadie reinstale. Las versiones anteriores
	 * a la 0.12 no la traen y los nodos viejos la ignoran.
	 */
	nodo?: Configuracion;
	sensorRemoto?: Configuracion;
};

export type Configuracion = {
	ficheros: Record<string, string>;
	entorno?: {
		/* Se añaden a .env solo si faltan, con este valor. Nunca se cambia una que ya exista. */
		nuevas?: Record<string, string>;
		/* Se añaden solo si faltan, con un secreto aleatorio generado en el propio nodo. */
		generar?: string[];
	};
};

/* Qué ficheros puede traer cada sección. Ni uno más: nada de escribir donde no toca. */
export const FICHEROS_CONFIGURACION = {
	nodo: ['compose.yml', 'Caddyfile'],
	sensorRemoto: ['compose.yml']
} as const;
const MAX_FICHERO = 64 * 1024;
const CLAVE_ENTORNO = /^[A-Z][A-Z0-9_]{0,63}$/;

export function motivoConfiguracion(
	seccion: keyof typeof FICHEROS_CONFIGURACION,
	c: unknown
): string | null {
	const x = c as Configuracion;
	if (!x || typeof x !== 'object' || !x.ficheros || typeof x.ficheros !== 'object')
		return `${seccion}: sin ficheros`;
	const permitidos: readonly string[] = FICHEROS_CONFIGURACION[seccion];
	for (const [nombre, texto] of Object.entries(x.ficheros)) {
		if (!permitidos.includes(nombre)) return `${seccion}: fichero no permitido (${nombre})`;
		if (typeof texto !== 'string' || Buffer.byteLength(texto) > MAX_FICHERO)
			return `${seccion}: ${nombre} no es texto o pasa de 64 KB`;
	}
	if (!('compose.yml' in x.ficheros)) return `${seccion}: falta compose.yml`;
	for (const [k, v] of Object.entries(x.entorno?.nuevas ?? {}))
		if (!CLAVE_ENTORNO.test(k) || typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 1024)
			return `${seccion}: variable de entorno mal formada (${k})`;
	for (const k of x.entorno?.generar ?? [])
		if (typeof k !== 'string' || !CLAVE_ENTORNO.test(k))
			return `${seccion}: variable a generar mal formada (${k})`;
	return null;
}

export type ReleaseFirmada = { release: string; firma: string };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
/* Registro opcional (con puerto si hace falta), repositorio, etiqueta opcional y digest obligatorio. */
const IMAGEN = /^([a-z0-9.-]+(:[0-9]+)?\/)?[a-z0-9._\/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

export function compararVersiones(a: string, b: string) {
	const x = SEMVER.exec(a);
	const y = SEMVER.exec(b);
	if (!x || !y) throw new Error(`versión mal formada: ${a} / ${b}`);
	for (let i = 1; i <= 3; i++)
		if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
	return 0;
}

export function firmarRelease(clavePrivada: string, r: Release): ReleaseFirmada {
	const texto = JSON.stringify(r);
	return {
		release: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64')
	};
}

export function verificarRelease(
	clavePublicaPublicacion: string,
	f: ReleaseFirmada
): { ok: true; release: Release } | { ok: false; motivo: string } {
	let valida = false;
	try {
		valida = verify(
			null,
			Buffer.from(f.release),
			publica(clavePublicaPublicacion),
			Buffer.from(f.firma, 'base64')
		);
	} catch {
		valida = false;
	}
	if (!valida) return { ok: false, motivo: 'la versión no está firmada por SeguridadSI' };
	const r = JSON.parse(f.release) as Release;
	if (!SEMVER.test(r.version)) return { ok: false, motivo: 'número de versión mal formado' };
	const servicios = Object.entries(r.servicios ?? {});
	if (servicios.length === 0) return { ok: false, motivo: 'la versión no trae servicios' };
	for (const [nombre, imagen] of servicios)
		if (!/^[a-z][a-z0-9-]{0,30}$/.test(nombre) || !IMAGEN.test(imagen))
			return { ok: false, motivo: `imagen de ${nombre} sin digest o mal formada` };
	if (r.actualizador !== undefined && !IMAGEN.test(r.actualizador))
		return { ok: false, motivo: 'imagen del actualizador sin digest o mal formada' };
	for (const seccion of ['nodo', 'sensorRemoto'] as const) {
		if (r[seccion] === undefined) continue;
		const m = motivoConfiguracion(seccion, r[seccion]);
		if (m) return { ok: false, motivo: m };
		if (!r.actualizador)
			return { ok: false, motivo: 'una versión con configuración tiene que traer el actualizador' };
	}
	return { ok: true, release: r };
}

/* ---------- lo que sube en cada latido ---------- */

/*
 * Lo mínimo para gobernar la flota, y nada más: ni eventos, ni IPs, ni
 * usuarios, ni secretos. Si un campo nuevo identifica a una persona, no va aquí.
 */
export type Latido = {
	version: string;
	sensores: { total: number; vivos: number };
	trampas: { total: number; activos: number };
	eventos24h: number;
	criticos24h: number;
	pendientes: number;
	comparticion: { compartir: boolean; recibir: boolean };
	/* Cómo va la actualización: lo que el panel necesita para avanzar los anillos. */
	actualizacion: {
		estado: 'al-dia' | 'pendiente' | 'aplicando' | 'fallida';
		version: string | null;
	};
	/* Qué ha decidido el cliente sobre el acceso de soporte, y a qué petición responde. */
	soporte: {
		estado: 'cerrado' | 'solicitado' | 'abierto' | 'rechazado';
		solicitud: string | null;
		hasta: string | null;
	};
	/*
	 * Cómo quedó la configuración firmada de la versión en la que está el nodo.
	 * Un nodo con la configuración fallida no cuenta como sano para su versión:
	 * el anillo se para. Opcional: los nodos anteriores a la 0.12 no la mandan.
	 */
	configuracion?: {
		version: string;
		estado: 'aplicando' | 'aplicada' | 'fallida';
		detalle: string | null;
	};
};

export type { KeyObject };

export * from './indicadores.ts';
export * from './licencia.ts';
