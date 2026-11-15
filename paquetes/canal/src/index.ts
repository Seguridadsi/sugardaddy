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
import type { MarcaFirmada } from './marca.ts';
import type { OrdenFirmada } from './ordenes.ts';
import { motivoInstalador, type InstaladorDeVersion } from './instalador.ts';
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
	if (!fecha || !firma) return { ok: false, motivo: 'missing signature headers' };
	const t = Date.parse(fecha);
	if (!Number.isFinite(t) || Math.abs(ahora - t) > MARGEN_RELOJ_MS)
		return { ok: false, motivo: 'date out of range' };
	const bytes = Buffer.from(firma, 'base64');
	let valida = false;
	try {
		valida = verify(
			null,
			Buffer.from(canonica(metodo, ruta, fecha, cuerpo)),
			publica(clavePublica),
			bytes
		);
	} catch {
		valida = false;
	}
	if (!valida) return { ok: false, motivo: 'invalid signature' };

	/* Por sus bytes, no por el texto: Buffer.from admite la misma firma escrita de varias formas. */
	const huella = bytes.toString('base64');
	for (const [f, cuando] of vistas) if (ahora - cuando > 2 * MARGEN_RELOJ_MS) vistas.delete(f);
	if (vistas.has(huella)) return { ok: false, motivo: 'repeated request' };
	vistas.set(huella, ahora);
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
	emitido: string;
	caduca: string;
};

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
 * claves: la clave del panel que el nodo fijó en el alta o, desde la rotación, la lista de las
 * que le ha dado una versión firmada (panel.ts). Vale `firma` o una de `firmas`.
 */
export function verificarEstado(
	clavesPanel: string | readonly string[],
	cliente: string,
	f: EstadoFirmado,
	ahora = Date.now()
): { ok: true; estado: EstadoDeseado } | { ok: false; motivo: string } {
	if (!f || typeof f.estado !== 'string' || motivoFirmas(f.firmas))
		return { ok: false, motivo: 'invalid Central signature' };
	if (!firmadoPorPanel(clavesPanel, f.estado, f.firma, f.firmas))
		return { ok: false, motivo: 'invalid Central signature' };
	const e = JSON.parse(f.estado) as EstadoDeseado;
	if (e.version !== 1) return { ok: false, motivo: 'unknown state version' };
	if (e.cliente !== cliente) return { ok: false, motivo: 'the state is for another customer' };
	if (Date.parse(e.caduca) < ahora) return { ok: false, motivo: 'the state has expired' };
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
	 * Las claves del panel en las que confiarán los nodos de ese panel (panel.ts): así rota
	 * la clave del estado deseado sin reinstalar, firmado con la de publicación, que no vive
	 * en Azure. Los nodos y los paneles anteriores lo ignoran.
	 */
	clavesPanel?: ClavesPanel;
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
	const m = motivoNovedades(r, uso) ?? motivoInstalador(r, f.release);
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
export * from './catalogo-partner.ts';
export * from './planes.ts';
export * from './registro.ts';
export * from './confianza.ts';
export * from './raiz.ts';
export * from './marca.ts';
export * from './transparencia.ts';
export * from './instalador.ts';
export * from './panel.ts';
export * from './rangos-nubes.ts';
export * from './ordenes.ts';
export * from './rele-minimo.ts';
