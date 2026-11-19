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
	randomBytes,
	sign,
	timingSafeEqual,
	verify,
	type KeyObject
} from 'node:crypto';
import type { LicenciaFirmada } from './licencia.ts';
import type { RevocacionFirmada } from './revocacion.ts';
import type { MarcaFirmada } from './marca.ts';
import type { OrdenFirmada } from './ordenes.ts';
import type { LatidoDisco } from './disco-latido.ts';
import {
	motivoInstalador,
	motivoInstaladorSensor,
	type InstaladorDeVersion,
	type InstaladorSensorDeVersion
} from './instalador.ts';
import {
	aConfianza,
	firmadoPor,
	firmasExtra,
	hayClave,
	leerConfianza,
	motivoClaves,
	motivoClavesMarca,
	motivoFirmas,
	type Confianza,
	type Firma
} from './confianza.ts';
import { firmadoPorPanel, motivoClavesPanel, type ClavesPanel } from './panel.ts';

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

/*
 * Dos cadenas canónicas (auditoría 2026-11-14, «canal firmado»):
 *
 * - la de siempre (`x-firma`): método, ruta, fecha y sha256 del cuerpo. No lleva el nodo: la
 *   identidad sale de la cabecera `x-nodo`, que solo elige la clave con la que se comprueba.
 * - la 2 (`x-firma-2`, desde la 0.32): la misma más un prefijo propio y el id del nodo. Una
 *   firma de un nodo ya no puede pasar por la de otro aunque compartieran clave, ni por la
 *   de otro documento firmado con la misma clave.
 *
 * Transición: el nodo nuevo manda las dos. El panel anterior solo mira `x-firma` y sigue
 * aceptándolo; el panel nuevo exige `x-firma-2` si viene y, si no viene (un nodo anterior),
 * acepta `x-firma` y lo cuenta como firma antigua (`legado`). Cuando no quede ningún nodo
 * anterior, el panel puede exigirla siempre (`exigirNodo`) y el nodo dejar de mandar la vieja.
 */
const PREFIJO_CANONICA_2 = 'sugardaddy-canal-2';

function canonica(metodo: string, ruta: string, fecha: string, cuerpo: string) {
	const h = createHash('sha256').update(cuerpo).digest('hex');
	return `${metodo.toUpperCase()}\n${ruta}\n${fecha}\n${h}`;
}

function canonica2(nodo: string, metodo: string, ruta: string, fecha: string, cuerpo: string) {
	return `${PREFIJO_CANONICA_2}\n${nodo}\n${canonica(metodo, ruta, fecha, cuerpo)}`;
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
	const clave = privada(clavePrivada);
	const firma = sign(null, Buffer.from(canonica(metodo, ruta, fecha, cuerpo)), clave);
	const firma2 = sign(null, Buffer.from(canonica2(nodo, metodo, ruta, fecha, cuerpo)), clave);
	return {
		'x-nodo': nodo,
		'x-fecha': fecha,
		'x-firma': firma.toString('base64'),
		'x-firma-2': firma2.toString('base64')
	};
}

export type Verificacion = { ok: true; legado: boolean } | { ok: false; motivo: string };

export type CabecerasPeticion = {
	fecha: string | null;
	firma: string | null;
	/* Desde la 0.32; los nodos anteriores no la mandan. */
	firma2?: string | null;
	nodo?: string | null;
};

/* Las cabeceras del canal de una petición, para comprobarPeticion y verificarPeticion. */
export const cabecerasDe = (h: { get(n: string): string | null }): CabecerasPeticion => ({
	nodo: h.get('x-nodo'),
	fecha: h.get('x-fecha'),
	firma: h.get('x-firma'),
	firma2: h.get('x-firma-2')
});

function firmaValidaSobre(clavePublica: string, texto: string, bytes: Buffer) {
	try {
		return verify(null, Buffer.from(texto), publica(clavePublica), bytes);
	} catch {
		return false;
	}
}

/*
 * Firma y reloj, sin la repetición: `huellas` son las firmas de la petición por sus bytes
 * (Buffer.from admite la misma firma escrita de varias formas), y quien la acepta tiene que
 * apuntarlas todas como vistas. Todas, también la vieja de una petición que trae las dos:
 * quitarle `x-firma-2` a una petición ya vista no la convierte en otra.
 */
export function comprobarPeticion(
	clavePublica: string,
	cabeceras: CabecerasPeticion,
	metodo: string,
	ruta: string,
	cuerpo: string,
	ahora = Date.now(),
	opciones: { exigirNodo?: boolean } = {}
): { ok: true; legado: boolean; huellas: string[] } | { ok: false; motivo: string } {
	const { fecha, firma, firma2, nodo } = cabeceras;
	if (!fecha || (!firma && !firma2)) return { ok: false, motivo: 'missing signature headers' };
	const t = Date.parse(fecha);
	if (!Number.isFinite(t) || Math.abs(ahora - t) > MARGEN_RELOJ_MS)
		return { ok: false, motivo: 'date out of range' };
	const huellas: string[] = [];
	let legado: boolean;
	if (firma2) {
		/* Si viene la nueva, manda ella: no se cae a la vieja si no cuadra. */
		if (!nodo) return { ok: false, motivo: 'missing signature headers' };
		const bytes = Buffer.from(firma2, 'base64');
		if (!firmaValidaSobre(clavePublica, canonica2(nodo, metodo, ruta, fecha, cuerpo), bytes))
			return { ok: false, motivo: 'invalid signature' };
		huellas.push(bytes.toString('base64'));
		legado = false;
	} else {
		if (opciones.exigirNodo) return { ok: false, motivo: 'old signature format' };
		const bytes = Buffer.from(firma!, 'base64');
		if (!firmaValidaSobre(clavePublica, canonica(metodo, ruta, fecha, cuerpo), bytes))
			return { ok: false, motivo: 'invalid signature' };
		legado = true;
	}
	if (firma) huellas.push(Buffer.from(firma, 'base64').toString('base64'));
	return { ok: true, legado, huellas };
}

/* Cuánto hay que recordar una firma aceptada: lo que dura la fecha más el margen. */
export const RECORDAR_FIRMA_MS = 2 * MARGEN_RELOJ_MS;

/*
 * Firma, reloj y repetición. `vistas` guarda las firmas aceptadas dentro del
 * margen de reloj: la misma petición no vale dos veces. En memoria: el panel
 * guarda las suyas en Postgres (comprobarPeticion y la tabla firmas_vistas).
 */
export function verificarPeticion(
	clavePublica: string,
	cabeceras: CabecerasPeticion,
	metodo: string,
	ruta: string,
	cuerpo: string,
	vistas: Map<string, number>,
	ahora = Date.now(),
	opciones: { exigirNodo?: boolean } = {}
): Verificacion {
	const v = comprobarPeticion(clavePublica, cabeceras, metodo, ruta, cuerpo, ahora, opciones);
	if (!v.ok) return v;
	for (const [f, cuando] of vistas) if (ahora - cuando > RECORDAR_FIRMA_MS) vistas.delete(f);
	if (v.huellas.some((h) => vistas.has(h))) return { ok: false, motivo: 'repeated request' };
	for (const h of v.huellas) vistas.set(h, ahora);
	return { ok: true, legado: v.legado };
}

/* ---------- bajada: estado deseado firmado por el panel ---------- */

export type EstadoDeseado = {
	version: 1;
	/*
	 * Qué documento es, dentro de lo firmado (desde la 0.32): con la misma clave del panel se
	 * firman también la lista global y la de Tor, y ninguna puede pasar por otra. Opcional
	 * porque los paneles anteriores no lo mandan (verificarEstado los acepta como `legado`);
	 * los nodos anteriores lo ignoran.
	 */
	tipo?: typeof TIPO_ESTADO;
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
	 * Las revocaciones de las licencias de este cliente, firmadas fuera del panel con la
	 * clave de licencias (revocacion.ts). Es lo único que para una trampa de pago ya
	 * desplegada: una licencia caducada solo impide desplegar o cambiar. El nodo guarda
	 * todas las que ve y no olvida ninguna. Opcional: los nodos anteriores lo ignoran.
	 */
	revocaciones?: RevocacionFirmada[];
	/*
	 * sha256 del logotipo del cliente, o nulo. El nodo lo pide aparte cuando
	 * cambia y comprueba que coincide: así viaja firmado sin engordar cada latido.
	 * Opcional porque los paneles anteriores a la 0.11 no lo mandan.
	 */
	logo?: string | null;
	/* sha256 de la lista firmada de nodos de salida de Tor; el nodo la pide aparte cuando cambia. */
	tor?: string | null;
	/*
	 * Hay balizas de este cliente esperando en la bandeja de salida del panel:
	 * eventos de honeycosas externas que volvieron por el relé público
	 * (docs/diseno/rele-balizas.md). El nodo, si lo ve, las recoge por
	 * /api/nodo/rele en la misma tanda del latido y las ingiere como eventos
	 * baliza. Solo una señal (no viajan aquí: pueden ser muchas y son dato
	 * hostil); el nodo las deduplica por su huella. Opcional: los nodos
	 * anteriores lo ignoran, y un panel sin relé nunca lo pone.
	 */
	releBalizas?: boolean;
	/*
	 * La dirección del relé público: el nombre DNS, sin esquema ni ruta, que el nodo
	 * siembra en sus cebos para que avisen fuera de su red (docs/diseno/rele-balizas.md).
	 * Sale de un único ajuste del panel (SD_RELE_DIRECCION). Con un nombre, el nodo lo
	 * guarda si pasa direccionReleValida; con null, este panel no tiene relé y el nodo
	 * olvida el que tuviera; ausente, es un panel anterior y el nodo no toca nada.
	 * Opcional: los nodos anteriores lo ignoran.
	 */
	rele?: string | null;
	/*
	 * Código para recuperar una contraseña que SeguridadSI ha mandado desde su
	 * panel al correo de contacto del cliente. Aquí solo viaja su hash: el código
	 * va por correo, nunca por el canal. El nodo lo guarda para ese usuario local y
	 * se canjea en /entrar/recuperar. Opcional: los nodos anteriores lo ignoran.
	 */
	recuperacion?: RecuperacionPanel | null;
	/*
	 * Quién lleva este panel, si no es SeguridadSI: el nombre del MSP, para los
	 * textos de la consola (docs/diseno/msp.md). Opcional: los nodos anteriores lo
	 * ignoran, y el panel de SeguridadSI no lo manda.
	 */
	operador?: string;
	/*
	 * La marca de tiempo firmada con la clave de publicación (docs/diseno/firmas-raiz.md),
	 * tal como la baja el panel de la copia estática: el panel solo la reparte. El
	 * actualizador la compara con la que baja él mismo y avisa si caduca o si hay una
	 * versión más nueva que no le llega. Opcional: los nodos anteriores la ignoran.
	 */
	marca?: MarcaFirmada | null;
	/*
	 * sha256 del paquete de trampas del partner que lleva este panel (su catálogo firmado y
	 * sus manifiestos), o nulo si no tiene (docs/diseno/trampas-de-partner.md). El nodo lo
	 * pide aparte cuando cambia y comprueba la cadena entera con sus claves de publicación.
	 * Opcional: los nodos anteriores lo ignoran, y el panel de SeguridadSI no lo manda.
	 */
	catalogoPartner?: string | null;
	/*
	 * Incidentes que alguien del panel atiende y el nodo aún no lo sabe: al aplicarlos dejan
	 * de escalarse (docs/diseno/vista-soc.md). Opcional: los nodos anteriores lo ignoran.
	 */
	atenciones?: AtencionIncidente[];
	/*
	 * La misma dirección del relé y el mismo código de recuperación, firmados además con una
	 * clave de publicación (ordenes.ts, docs/diseno/frenos-del-nodo.md). Los nodos desde la
	 * versión de los frenos solo aceptan `rele` y `recuperacion` si vienen así; los anteriores
	 * siguen leyendo los campos sin firmar, que el panel manda mientras queden.
	 */
	releFirmado?: OrdenFirmada;
	recuperacionFirmada?: OrdenFirmada;
	/*
	 * Una orden firmada con una clave de publicación que mueve al nodo a otra dirección del
	 * panel (ordenes.ts, `panel`): un traslado planificado. Con el panel caído, la misma orden
	 * está en el repo público. Opcional: los nodos anteriores la ignoran.
	 */
	panelFirmado?: OrdenFirmada;
	/*
	 * Cuándo lo firmó el panel. Desde la 0.32 el nodo no acepta un estado tipado más viejo que
	 * el último que aceptó (verificarEstado, `ultimoEmitido`): repetir uno anterior capturado no
	 * deshace lo que el panel ya ha cambiado.
	 */
	emitido: string;
	caduca: string;
};

export const TIPO_ESTADO = 'estado';

export type AtencionIncidente = { id: string; por: string };

/*
 * Un nombre DNS con al menos dos etiquetas y sin nada más: ni esquema, ni puerto,
 * ni ruta, ni usuario, ni una IP. Esta dirección acaba dentro de los documentos cebo
 * como https://<dirección>/b/<token>, así que lo que no sea un nombre limpio no entra
 * (lo comprueban el panel antes de firmarla y el nodo al recibirla y al usarla).
 */
const DIRECCION_RELE =
	/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

export function direccionReleValida(d: unknown): d is string {
	return typeof d === 'string' && DIRECCION_RELE.test(d);
}

/*
 * Un incidente, tal como lo sube un nodo cuyo cliente ha decidido compartirlos
 * (docs/diseno/vista-soc.md). Nada de lo que escribió el atacante.
 */
export type IncidenteSubido = {
	id: string;
	origen: string;
	estado: 'abierto' | 'cerrado';
	motivo: string;
	severidad: 'baja' | 'media' | 'alta' | 'critica';
	puntos: number;
	eventos: number;
	/* El nombre de las trampas tocadas, acotado. */
	trampas: string[];
	primero: string;
	ultimo: string;
	abierto: string;
	cerrado: string | null;
	/* Si alguien lo atiende y cómo, sin su nombre: es un empleado del cliente. */
	atendido: string | null;
	atendidoComo: string | null;
	escalados: number;
};

export type RecuperacionPanel = { id: string; usuario: string; codigoHash: string; caduca: string };

/*
 * Hash de un código de recuperación de contraseña, con sal: sha256$<sal>$<hex>.
 * Lo calculan el nodo (código pedido desde su entrada) y el panel (código que
 * manda SeguridadSI); lo comprueba siempre el nodo.
 */
export function hashCodigoRecuperacion(codigo: string, sal = randomBytes(16).toString('hex')) {
	return `sha256$${sal}$${createHash('sha256').update(`${sal}:${codigo}`).digest('hex')}`;
}

export function codigoRecuperacionCorrecto(codigo: string, almacenado: string) {
	const p = almacenado.split('$');
	if (p.length !== 3 || p[0] !== 'sha256') return false;
	const a = Buffer.from(hashCodigoRecuperacion(codigo, p[1]));
	const b = Buffer.from(almacenado);
	return a.length === b.length && timingSafeEqual(a, b);
}

/*
 * `tenant` (desde la 0.30): el tenant de Entra de SeguridadSI. Con el Entra propio del
 * cliente, la persona de soporte entra como invitada y la consola comprueba que la
 * autenticó ese tenant (claim `idp`). Va firmado con la petición para no fiarse del token.
 */
export type SolicitudSoporte = { por: string; motivo: string; cuando: string; tenant?: string };

/* firmas: las de las claves nuevas del panel (panel.ts), junto a la de siempre en `firma`. */
export type EstadoFirmado = { estado: string; firma: string; firmas?: Firma[] };

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

/*
 * Cuánto puede ir por delante del reloj del nodo la fecha de emisión de un estado. Holgado:
 * solo está para que un estado con el reloj del panel disparado no deje al nodo sin aceptar
 * ninguno hasta esa fecha.
 */
export const MARGEN_EMITIDO_MS = 24 * 3600_000;

export type EstadoVerificado = {
	ok: true;
	estado: EstadoDeseado;
	/* Firmado por un panel anterior a la 0.32: sin `tipo`, y no cuenta para `ultimoEmitido`. */
	legado: boolean;
};

/*
 * claves: la clave del panel que el nodo fijó en el alta o, desde la rotación, la lista de las
 * que le ha dado una versión firmada (panel.ts). Vale `firma` o una de `firmas`.
 *
 * ultimoEmitido: el `emitido` del último estado tipado que aceptó el nodo. Un estado anterior a
 * él no vale, tenga tipo o no: es una repetición. Solo los tipados lo hacen avanzar, porque el
 * panel anterior reutiliza firmas de hasta media hora y puede volver a mandar uno más viejo
 * (y un estado sin tipo caduca en una hora: pasada la transición no queda ninguno vigente).
 */
export function verificarEstado(
	clavesPanel: string | readonly string[],
	cliente: string,
	f: EstadoFirmado,
	ahora = Date.now(),
	opciones: { ultimoEmitido?: string | null } = {}
): EstadoVerificado | { ok: false; motivo: string } {
	if (!f || typeof f.estado !== 'string' || motivoFirmas(f.firmas))
		return { ok: false, motivo: 'invalid Central signature' };
	if (!firmadoPorPanel(clavesPanel, f.estado, f.firma, f.firmas))
		return { ok: false, motivo: 'invalid Central signature' };
	let e: EstadoDeseado;
	try {
		e = JSON.parse(f.estado) as EstadoDeseado;
	} catch {
		return { ok: false, motivo: 'not a desired state' };
	}
	if (!e || typeof e !== 'object') return { ok: false, motivo: 'not a desired state' };
	if (e.tipo !== undefined && e.tipo !== TIPO_ESTADO)
		return { ok: false, motivo: 'not a desired state' };
	if (e.version !== 1) return { ok: false, motivo: 'unknown state version' };
	if (e.cliente !== cliente) return { ok: false, motivo: 'the state is for another customer' };
	/* Una fecha que no se lee (NaN) no puede valer para siempre (auditoría 2026-11-14, §5 h07). */
	const caduca = Date.parse(e.caduca);
	if (!Number.isFinite(caduca) || caduca < ahora)
		return { ok: false, motivo: 'the state has expired' };
	const emitido = Date.parse(e.emitido);
	if (!Number.isFinite(emitido) || emitido > ahora + MARGEN_EMITIDO_MS)
		return { ok: false, motivo: 'the state has an invalid issue date' };
	const ultimo = opciones.ultimoEmitido ? Date.parse(opciones.ultimoEmitido) : NaN;
	if (Number.isFinite(ultimo) && emitido < ultimo)
		return { ok: false, motivo: 'the state is older than the last one accepted' };
	return { ok: true, estado: e, legado: e.tipo === undefined };
}

/* El `emitido` que queda como último aceptado tras aceptar `v` (verificarEstado). */
export function ultimoEmitidoTras(
	previo: string | null | undefined,
	v: EstadoVerificado
): string | null {
	if (v.legado) return previo ?? null;
	const p = previo ? Date.parse(previo) : NaN;
	if (!Number.isFinite(p) || Date.parse(v.estado.emitido) > p) return v.estado.emitido;
	return previo ?? null;
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
	/*
	 * Desde la 0.25 (docs/diseno/claves-y-catalogo.md). confianza: las claves en las que
	 * confiarán el nodo y el sensor remoto (PUBLICACION_CLAVES), y si se retira la de
	 * legado. catalogo: lo único que el sensor puede arrancar, la huella de cada manifiesto
	 * por módulo (SEN-3). commit: de qué commit sale la versión (SUP-4).
	 */
	/* marcas: las claves de la marca de tiempo (PUBLICACION_MARCAS, docs/diseno/firmas-raiz.md). */
	confianza?: { claves: string; retirarLegado?: boolean; marcas?: string };
	catalogo?: Record<string, string[]>;
	commit?: string;
	/*
	 * Con qué se instala esta versión desde cero (instalador.ts, SUP-7): la primera etapa,
	 * estática y firmada, los guiones del nodo y la huella de cada pieza. Los nodos y los
	 * paneles anteriores lo ignoran.
	 */
	instalador?: InstaladorDeVersion;
	/*
	 * El Docker que fija la versión (docs/diseno/cortafuegos-anfitrion.md): la consola avisa
	 * si la máquina va por detrás y el appliance sube a él con estos paquetes y sus sha256.
	 * Los nodos anteriores lo ignoran.
	 */
	motor?: MotorFijado;
	/*
	 * El guion del sensor remoto y sus huellas, para la etapa 1 en su modo de sensor
	 * (instalador.ts). Los nodos y paneles anteriores lo ignoran.
	 */
	instaladorSensor?: InstaladorSensorDeVersion;
	/*
	 * Las claves del panel en las que confiarán los nodos de ese panel (panel.ts): así rota
	 * la clave del estado deseado sin reinstalar, firmado con la de publicación, que no vive
	 * en Azure. Los nodos y los paneles anteriores lo ignoran.
	 */
	clavesPanel?: ClavesPanel;
	/*
	 * Un arreglo de seguridad: se salta el retardo mínimo de la política de cambios del cliente,
	 * pero no su aprobación (docs/diseno/politica-cambios.md). Va firmado, así que el panel no
	 * puede marcar urgente una versión que no lo es. Los nodos anteriores lo ignoran.
	 */
	urgente?: boolean;
};

/*
 * De qué edición es una versión, por el registro de sus imágenes: Cloud las
 * sirve desde el registro privado de Azure (*.azurecr.io) y Community desde
 * ghcr.io. Las dos se firman con la misma clave (SUP-1), así que el panel y la
 * consola miran esto para que una versión de Community no llegue a un nodo de
 * pago ni al revés (SUP-3). null: ni una ni otra (desarrollo, registro local).
 */
export function edicionDeRelease(r: Pick<Release, 'servicios' | 'actualizador'>) {
	const imagenes = [
		...Object.values(r.servicios ?? {}),
		...(r.actualizador ? [r.actualizador] : [])
	];
	const host = (i: string) => i.split('/')[0].toLowerCase();
	if (imagenes.length === 0) return null;
	if (imagenes.every((i) => host(i).endsWith('.azurecr.io'))) return 'cloud' as const;
	/* Todas en ghcr.io: con registros mezclados no es de ninguna edición (solo el legado). */
	if (imagenes.every((i) => host(i) === 'ghcr.io')) return 'community' as const;
	return null;
}

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
		return `${seccion}: no files`;
	const permitidos: readonly string[] = FICHEROS_CONFIGURACION[seccion];
	for (const [nombre, texto] of Object.entries(x.ficheros)) {
		if (!permitidos.includes(nombre)) return `${seccion}: file not allowed (${nombre})`;
		if (typeof texto !== 'string' || Buffer.byteLength(texto) > MAX_FICHERO)
			return `${seccion}: ${nombre} is not text or exceeds 64 KB`;
	}
	if (!('compose.yml' in x.ficheros)) return `${seccion}: compose.yml is missing`;
	for (const [k, v] of Object.entries(x.entorno?.nuevas ?? {}))
		if (!CLAVE_ENTORNO.test(k) || typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 1024)
			return `${seccion}: malformed environment variable (${k})`;
	for (const k of x.entorno?.generar ?? [])
		if (typeof k !== 'string' || !CLAVE_ENTORNO.test(k))
			return `${seccion}: malformed variable to generate (${k})`;
	return null;
}

export type ReleaseFirmada = { release: string; firma: string; firmas?: Firma[] };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
/* Registro opcional (con puerto si hace falta), repositorio, etiqueta opcional y digest obligatorio. */
const IMAGEN = /^([a-z0-9.-]+(:[0-9]+)?\/)?[a-z0-9._\/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

export function compararVersiones(a: string, b: string) {
	const x = SEMVER.exec(a);
	const y = SEMVER.exec(b);
	if (!x || !y) throw new Error(`malformed version: ${a} / ${b}`);
	for (let i = 1; i <= 3; i++)
		if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
	return 0;
}

/* extra: las claves nuevas, que firman además en `firmas` (docs/diseno/claves-y-catalogo.md). */
export function firmarRelease(
	clavePrivada: string,
	r: Release,
	extra: readonly { privada: string; publica: string }[] = []
): ReleaseFirmada {
	const texto = JSON.stringify(r);
	return {
		release: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64'),
		...(extra.length ? { firmas: firmasExtra(texto, extra) } : {})
	};
}

const MODULO_CATALOGO = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HUELLA_MANIFIESTO = /^[0-9a-f]{64}$/;

/* Qué falla en las piezas de la 0.25 de una versión (confianza, catálogo, commit), o null. */
function motivoNovedades(r: Release, uso: ReturnType<typeof edicionDeRelease>): string | null {
	if (r.confianza !== undefined) {
		const c = r.confianza as Release['confianza'];
		if (!c || typeof c !== 'object' || typeof c.claves !== 'string')
			return 'malformed trusted keys';
		const m = motivoClaves(c.claves);
		if (m) return m;
		if (c.retirarLegado !== undefined && typeof c.retirarLegado !== 'boolean')
			return 'malformed trusted keys';
		if (c.marcas !== undefined) {
			if (typeof c.marcas !== 'string') return 'malformed trusted keys';
			const mm = motivoClavesMarca(c.marcas);
			if (mm) return `timestamp keys: ${mm}`;
		}
		/* Sin una clave de su propio uso, el nodo no podría comprobar la versión siguiente. */
		const usos = new Set(leerConfianza(c.claves).claves.map((k) => k.uso));
		if (!uso || !usos.has(uso)) return 'the trusted keys leave this edition without a key';
		/* Sin legado, cada cosa que el nodo comprueba necesita su clave. */
		if (
			c.retirarLegado &&
			(!usos.has('delegaciones') || (uso === 'cloud' && !usos.has('licencias')))
		)
			return 'retiring the legacy key would leave licenses or delegations without a key';
	}
	/* Como en Go (bool): un «urgente» que no es booleano no se acepta. */
	if (r.urgente !== undefined && typeof r.urgente !== 'boolean') return 'malformed urgent flag';
	if (r.catalogo !== undefined) {
		const c = r.catalogo as unknown;
		if (!c || typeof c !== 'object' || Array.isArray(c)) return 'malformed decoy catalog';
		const entradas = Object.entries(c as Record<string, unknown>);
		if (entradas.length > 500) return 'the decoy catalog is too large';
		for (const [modulo, huellas] of entradas)
			if (
				!MODULO_CATALOGO.test(modulo) ||
				!Array.isArray(huellas) ||
				huellas.length === 0 ||
				huellas.length > 8 ||
				huellas.some((h) => typeof h !== 'string' || !HUELLA_MANIFIESTO.test(h))
			)
				return `malformed decoy catalog entry (${modulo.slice(0, 64)})`;
	}
	if (r.clavesPanel !== undefined) {
		const m = motivoClavesPanel(r.clavesPanel);
		if (m) return m;
	}
	if (r.commit !== undefined && (typeof r.commit !== 'string' || !/^[0-9a-f]{40}$/.test(r.commit)))
		return 'malformed commit';
	return null;
}

/*
 * clave: la confianza del que comprueba (o una clave suelta, que vale como la de legado).
 * La versión tiene que venir firmada por una clave del uso de su edición (cloud o
 * community, por el registro de sus imágenes) o por la de legado. firmadaCon: la huella
 * de la clave que la firmó.
 */
export function verificarRelease(
	clave: string | Confianza,
	f: ReleaseFirmada
): { ok: true; release: Release; firmadaCon: string } | { ok: false; motivo: string } {
	const confianza = aConfianza(clave);
	if (!f || typeof f.release !== 'string' || motivoFirmas(f.firmas))
		return { ok: false, motivo: 'does not have the form of a signed version' };
	let r: Release;
	try {
		r = JSON.parse(f.release) as Release;
	} catch {
		return { ok: false, motivo: 'the version is not signed by SeguridadSI' };
	}
	if (!r || typeof r !== 'object')
		return { ok: false, motivo: 'the version is not signed by SeguridadSI' };
	const uso = edicionDeRelease(r);
	if (!hayClave(confianza, uso))
		return { ok: false, motivo: 'there is no trusted key to check this version' };
	const firmadaCon = firmadoPor(confianza, uso, f.release, f.firma, f.firmas);
	if (!firmadaCon) return { ok: false, motivo: 'the version is not signed by SeguridadSI' };
	if (!SEMVER.test(r.version)) return { ok: false, motivo: 'malformed version number' };
	const servicios = Object.entries(r.servicios ?? {});
	if (servicios.length === 0) return { ok: false, motivo: 'the version includes no services' };
	for (const [nombre, imagen] of servicios)
		if (!/^[a-z][a-z0-9-]{0,30}$/.test(nombre) || !IMAGEN.test(imagen))
			return { ok: false, motivo: `image for ${nombre} has no digest or is malformed` };
	if (r.actualizador !== undefined && !IMAGEN.test(r.actualizador))
		return { ok: false, motivo: 'updater image has no digest or is malformed' };
	for (const seccion of ['nodo', 'sensorRemoto'] as const) {
		if (r[seccion] === undefined) continue;
		const m = motivoConfiguracion(seccion, r[seccion]);
		if (m) return { ok: false, motivo: m };
		if (!r.actualizador)
			return { ok: false, motivo: 'a version with configuration must include the updater' };
	}
	const m =
		motivoNovedades(r, uso) ??
		motivoInstalador(r, f.release) ??
		motivoInstaladorSensor(r, f.release);
	if (m) return { ok: false, motivo: m };
	return { ok: true, release: r, firmadaCon };
}

/* ---------- lo que sube en cada latido ---------- */

/*
 * Lo mínimo para gobernar la flota, y nada más: ni eventos, ni IPs, ni
 * usuarios, ni secretos. Si un campo nuevo identifica a una persona, no va aquí.
 */
export type Latido = {
	version: string;
	/*
	 * Latido mínimo (Ajustes → Central de la consola, docs/seguridad/flujo-de-datos.md): el
	 * cliente elige mandar solo lo que hace falta para la licencia y las actualizaciones. Sin
	 * cifras (sensores, trampas, eventos, pendientes), ni cómo se entra en la consola, ni el
	 * sello de la auditoría, ni el aislamiento, ni la salida a internet: el nodo no las
	 * calcula. El panel lo enseña como «minimal» y no cuenta lo que no sabe.
	 */
	minimo?: true;
	/* Las cifras: en un latido mínimo no van (el panel las trata como desconocidas). */
	sensores?: { total: number; vivos: number };
	trampas?: { total: number; activos: number };
	eventos24h?: number;
	criticos24h?: number;
	pendientes?: number;
	comparticion: { compartir: boolean; recibir: boolean };
	/* Cómo va la actualización: lo que el panel necesita para avanzar los anillos. */
	actualizacion: {
		estado: 'al-dia' | 'pendiente' | 'aplicando' | 'fallida';
		version: string | null;
		/*
		 * Una pendiente que espera por la política de cambios del cliente: su aprobación o el
		 * retardo mínimo (docs/diseno/politica-cambios.md). Es decisión suya: no dice nada de la
		 * versión y el panel no la cuenta para los anillos. Opcional: los nodos anteriores no lo
		 * mandan y los paneles anteriores lo ignoran.
		 */
		espera?: 'aprobacion' | 'retardo';
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
	/*
	 * Solo si el cliente comparte sus incidentes o tiene abierto el soporte: lo que el panel
	 * necesita para vigilarle. Sin eso no sube nada, ni la dirección de la consola.
	 */
	vigilancia?: { incidentes: boolean; consola: string | null };
	/*
	 * Lo que el actualizador dice de la marca de tiempo (docs/diseno/firmas-raiz.md): si está
	 * al día, si su marca caducó sin que nadie le dé otra o si hay una versión más nueva que
	 * no le llega (retenida). Opcional: los nodos anteriores no lo mandan.
	 */
	marca?: EstadoMarcaNodo;
	/*
	 * Las huellas de las claves del panel en las que confía el nodo: el panel sabe así cuándo
	 * puede dejar de firmar con la de antes (docs/diseno/panel-endurecido.md). Opcional.
	 */
	clavesPanel?: string[];
	/*
	 * La orden de dirección del panel que siguió el nodo, si alguna (su fecha y si llegó por el
	 * panel o por el repo público). Para contar en el panel nuevo quién ha llegado. Opcional.
	 */
	ordenPanel?: { emitida: string; origen: 'panel' | 'estatica' };
	/*
	 * Desde la 0.30: cómo se entra en la consola (`local`, `propio` = Entra del cliente,
	 * `seguridadsi` = invitados B2B en el tenant de SeguridadSI) y en qué punto está su
	 * salida del B2B. El panel lo enseña para seguir la migración (identidad-clientes.md §4).
	 */
	acceso?: { modo: 'local' | 'propio' | 'seguridadsi'; b2b: 'no' | 'activo' | 'retirado' };
	/*
	 * El último sello de la auditoría de la consola (docs/diseno/auditoria-inmutable.md):
	 * el hash de su cabeza firmado con la clave del nodo. Opcional: los nodos anteriores
	 * no lo mandan.
	 */
	auditoria?: {
		hasta: number;
		hash: string;
		cuando: string;
		algoritmo: 'ed25519' | 'hmac-sha256';
		firma: string;
	};
	/*
	 * Con qué se aíslan las trampas del nodo (motor.aislamiento,
	 * docs/diseno/aislamiento-trampas.md): el más débil de sus sensores vivos que lo
	 * dicen. runsc (gVisor), runc-perfiles (seccomp y AppArmor de Sugardaddy),
	 * runc-seccomp (sin AppArmor) o runc-docker (un sensor sin sd-motor, con el
	 * socket de Docker). Opcional: los nodos anteriores no lo mandan.
	 */
	aislamiento?: Aislamiento;
	/*
	 * Desde la 0.30 (docs/diseno/proxy-salida.md): si el nodo sale por un proxy y si llega a
	 * cada destino que usa (nombres de SeguridadSI y Microsoft, nunca los del cliente ni el
	 * proxy). Para ver desde el panel por qué un nodo detrás de un banco no se actualiza.
	 */
	salida?: {
		proxy: boolean;
		destinos: { destino: string; ok: boolean; detalle: string | null }[];
		cuando: string;
	};
	/*
	 * Desde la 0.32 (docs/diseno/cortafuegos-anfitrion.md): la máquina del nodo, resumida.
	 * Sin usuarios ni huellas de claves: solo cuántos, el estado del cortafuegos estricto,
	 * de auditd y la versión de Docker frente a la que fija la versión firmada.
	 */
	anfitrion?: LatidoAnfitrion;
	/*
	 * Desde la 0.32 (docs/diseno/disco-cifrado.md): el disco de datos del appliance, el más
	 * débil de sus sensores vivos que lo dicen. Dos booleanos (cifrado, sellado al TPM).
	 * Opcional: un nodo instalado a mano no lo informa. No va en el mínimo.
	 */
	disco?: LatidoDisco;
	/*
	 * Una ventana de mantenimiento en curso en el nodo (parches, reinicios).
	 * `nodo`: cubre todo el nodo, y hasta `hasta` el panel no lo escala como caído si deja de
	 * latir; `sensoresParados`: los sensores sin latido que lo están por mantenimiento, que no
	 * cuentan como caídos. Solo mientras dura. Opcional: los nodos anteriores no lo mandan y
	 * los paneles anteriores lo ignoran.
	 */
	mantenimiento?: LatidoMantenimiento;
	/*
	 * La última comprobación de integridad del nodo (integridad.ts de la consola, que la
	 * recibe del actualizador cada 10 minutos): cuándo fue y cuántas desviaciones vio. Solo
	 * el número: el detalle (rutas, nombres de variables) se queda en el nodo. Opcional: los
	 * nodos anteriores no lo mandan. No va en el mínimo.
	 */
	integridad?: LatidoIntegridad;
	/*
	 * Las líneas de la cola de entrega que los sensores apartaron porque la consola no las
	 * sabía procesar (hecho entrega.apartadas, auditoría del 2026-11-14 C01): la suma de
	 * todos sus sensores y en cuántos pasó. Opcional. No va en el mínimo.
	 */
	entrega?: LatidoEntrega;
};

export type LatidoIntegridad = { comprobado: string; desviaciones: number };
export type LatidoEntrega = { apartadas: number; sensores: number };

const ENTERO_LATIDO = (n: unknown, max: number): n is number =>
	typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;

/* Lo que el panel acepta de la integridad del latido: mal formada, se ignora. */
export function leerIntegridadLatido(x: unknown): LatidoIntegridad | undefined {
	if (!x || typeof x !== 'object') return undefined;
	const m = x as Record<string, unknown>;
	const cuando =
		typeof m.comprobado === 'string' && m.comprobado.length <= 40 ? Date.parse(m.comprobado) : NaN;
	if (!Number.isFinite(cuando) || !ENTERO_LATIDO(m.desviaciones, 1000)) return undefined;
	return { comprobado: new Date(cuando).toISOString(), desviaciones: m.desviaciones };
}

/* Lo que el panel acepta de la entrega del latido: mal formada, se ignora. */
export function leerEntregaLatido(x: unknown): LatidoEntrega | undefined {
	if (!x || typeof x !== 'object') return undefined;
	const m = x as Record<string, unknown>;
	if (!ENTERO_LATIDO(m.apartadas, 1e9) || !ENTERO_LATIDO(m.sensores, 100_000)) return undefined;
	return { apartadas: m.apartadas, sensores: m.sensores };
}

export type LatidoMantenimiento = { hasta: string; nodo: boolean; sensoresParados: number };

/* El tope de una ventana en el nodo es de 72 h; el panel no cree una que diga más de una semana. */
const MANTENIMIENTO_MAXIMO_MS = 7 * 86_400_000;

/* Lo que el panel acepta del latido: mal formado o fuera de plazo, se ignora. */
export function leerMantenimientoLatido(
	x: unknown,
	ahora = Date.now()
): LatidoMantenimiento | undefined {
	if (!x || typeof x !== 'object') return undefined;
	const m = x as Record<string, unknown>;
	const hasta = typeof m.hasta === 'string' ? Date.parse(m.hasta) : NaN;
	if (!Number.isFinite(hasta) || hasta > ahora + MANTENIMIENTO_MAXIMO_MS) return undefined;
	if (typeof m.nodo !== 'boolean') return undefined;
	const n = m.sensoresParados;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) return undefined;
	return { hasta: new Date(hasta).toISOString(), nodo: m.nodo, sensoresParados: n };
}

/* ¿Sigue en curso la ventana que dijo el último latido? */
export const enMantenimiento = (m: LatidoMantenimiento | null | undefined, ahora = Date.now()) =>
	!!m && Date.parse(m.hasta) > ahora;

export const ESTADOS_ESTRICTO_LATIDO = [
	'apagado',
	'aplicada',
	'quitada',
	'revertida',
	'conflicto',
	'sin-nft',
	'suspendida',
	'error'
] as const;

export type LatidoAnfitrion = {
	estricto: (typeof ESTADOS_ESTRICTO_LATIDO)[number];
	auditd: string;
	ssh: { activo: boolean; usuarios: number; claves: number };
	docker: { version: string | null; fijada: string | null; desfasada: boolean };
};

export type MotorFijado = {
	docker: string;
	paquetes?: { nombre: string; version: string; sha256: string }[];
};

export type EstadoMarcaNodo = {
	estado: 'al-dia' | 'sin-marca' | 'caducada' | 'retenida';
	detalle: string;
	ultima: string | null;
	caduca: string | null;
	origen: string | null;
	/* Si la última versión ofrecida no estaba en el registro de transparencia, o no se pudo ver. */
	registro?: string | null;
};

/* Los valores de motor.aislamiento, del más fuerte al más débil. */
export const AISLAMIENTOS = ['runsc', 'runc-perfiles', 'runc-seccomp', 'runc-docker'] as const;
export type Aislamiento = (typeof AISLAMIENTOS)[number];

/* El más débil de varios (undefined si ninguno es conocido). */
export function aislamientoMasDebil(valores: unknown[]): Aislamiento | undefined {
	let peor = -1;
	for (const v of valores) peor = Math.max(peor, AISLAMIENTOS.indexOf(v as Aislamiento));
	return peor < 0 ? undefined : AISLAMIENTOS[peor];
}

export type { KeyObject };

export * from './indicadores.ts';
export * from './licencia.ts';
export * from './revocacion.ts';
export * from './retiradas.ts';
export * from './planes.ts';
export * from './registro.ts';
export * from './confianza.ts';
export * from './raiz.ts';
export * from './marca.ts';
export * from './transparencia.ts';
export * from './sello-auditoria.ts';
export * from './instalador.ts';
export * from './panel.ts';
export * from './rangos-nubes.ts';
export * from './ordenes.ts';
export * from './rele-minimo.ts';
export * from './disco-latido.ts';
