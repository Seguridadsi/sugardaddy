/*
 * Órdenes que la clave del panel sola no basta para dar (docs/diseno/frenos-del-nodo.md, R1-B
 * del análisis del 2026-11-14): la dirección del relé, que acaba dentro de cada cebo nuevo, y
 * el código para recuperar la contraseña de una consola. Con el panel tomado, quien tuviera su
 * clave podría mandar a toda la flota un relé suyo o cambiar la contraseña de administrador de
 * cada consola. Por eso estas dos órdenes viajan en el estado deseado firmadas, además, con una
 * clave de publicación de uso `delegaciones` (o la de legado), que no vive en el panel: la firma
 * Kino desde su Mac con herramientas/firmar-orden.sh (Key Vault de firmas con su sesión de az,
 * o la de reserva).
 *
 * Mismo formato que el resto de documentos firmados: `orden` es el texto exacto firmado, `firma`
 * la firma principal y `firmas` las de las claves nuevas (confianza.ts).
 */
import {
	aConfianza,
	firmadoPor,
	hayClave,
	motivoFirmas,
	type Confianza,
	type Firma
} from './confianza.ts';
import { direccionReleValida } from './index.ts';
import { motivoClavesPanel, type ClavesPanel } from './panel.ts';

export type OrdenFirmada = { orden: string; firma: string; firmas?: Firma[] };

/* La dirección del relé para toda la flota. null: no hay relé, los nodos olvidan el que tengan. */
export type OrdenRele = { tipo: 'rele'; version: 1; direccion: string | null; emitida: string };

/* Un código de recuperación para un usuario de la consola de un cliente. Solo viaja su hash. */
export type OrdenRecuperacion = {
	tipo: 'recuperacion';
	version: 1;
	cliente: string;
	id: string;
	usuario: string;
	codigoHash: string;
	caduca: string;
	emitida: string;
};

/*
 * La dirección del panel (recuperación ante la pérdida de la región,
 * docs/administrador/panel/perder-la-region.md). Los nodos la fijan en el alta; con el panel
 * caído en su región, uno levantado en otra con otro nombre no lo encuentra nadie. Esta orden
 * mueve a otra dirección a los nodos que estén en una de `antes` (nombres DNS): así una orden
 * de SeguridadSI no se lleva a los nodos de la central de un MSP. Solo vale entre `desde` y
 * `caduca` (como mucho 90 días después de emitirse): una orden vieja que alguien guarde no
 * puede usarse para llevar la flota a un nombre que ya no es nuestro. Puede traer las claves
 * del panel nuevo (`clavesPanel`, como una versión firmada), porque el HSM del panel se pierde
 * con su región. Llega en el estado deseado (traslado planificado) o en un fichero firmado del
 * repo público, que el nodo mira cuando el panel no le contesta.
 */
export type OrdenPanel = {
	tipo: 'panel';
	version: 1;
	/* https://nombre[:puerto], sin ruta, usuario, consulta ni fragmento. */
	direccion: string;
	/* Los nombres DNS de los paneles de los que se sale (el de la dirección que tiene el nodo). */
	antes: string[];
	desde: string;
	caduca: string;
	clavesPanel?: ClavesPanel;
	emitida: string;
};

export type Orden = OrdenRele | OrdenRecuperacion | OrdenPanel;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USUARIO = /^[a-z0-9._-]{3,32}$/;
const HASH = /^sha256\$[0-9a-f]{32}\$[0-9a-f]{64}$/;
/* Un código de recuperación no vale más de un día, aunque la orden lo diga. */
const MAX_VIDA_RECUPERACION = 24 * 3600_000;
/* Una orden del panel no vale más de 90 días: si hace falta más, se firma otra. */
export const MAX_VIDA_ORDEN_PANEL = 90 * 24 * 3600_000;
const MAX_ANTES = 8;
const fecha = (x: unknown) => typeof x === 'string' && Number.isFinite(Date.parse(x));

/*
 * Una dirección de panel que se puede dar por orden: https, con un nombre DNS (no una IP),
 * puerto opcional, y nada más. Se compara y se guarda tal cual, sin barra final.
 */
export function direccionPanelValida(d: unknown): d is string {
	if (typeof d !== 'string' || d.length > 300) return false;
	const m = /^https:\/\/([^/:?#@\s]+)(?::(\d{1,5}))?$/.exec(d);
	if (!m || !direccionReleValida(m[1])) return false;
	return m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 65535);
}

/* El nombre DNS de la dirección de un panel (en minúsculas), o null si no es una URL. */
export function nombrePanel(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

/*
 * Si una orden del panel (ya verificada) es para un nodo que está en `panelActual`, ahora: qué
 * falla, o null si se aplica. No mira firma ni la orden aplicada antes: eso lo hace quien la
 * guarda.
 */
export function motivoOrdenPanelAqui(
	o: OrdenPanel,
	panelActual: string,
	ahora = Date.now()
): string | null {
	if (ahora < Date.parse(o.desde)) return 'the Central address order is not valid yet';
	if (ahora > Date.parse(o.caduca)) return 'the Central address order has expired';
	const actual = nombrePanel(panelActual);
	if (!actual || !o.antes.includes(actual))
		return 'the Central address order is not for the Central this node uses';
	if (panelActual.replace(/\/+$/, '') === o.direccion) return 'the node already uses that address';
	return null;
}

/* Qué falla en una orden ya leída, o null si su forma vale. No mira firma ni reloj. */
export function motivoOrden(x: unknown): string | null {
	const o = x as Orden;
	if (!o || typeof o !== 'object' || o.version !== 1) return 'not an order';
	if (!fecha(o.emitida)) return 'malformed order date';
	if (o.tipo === 'rele')
		return o.direccion === null || direccionReleValida(o.direccion)
			? null
			: 'malformed relay address';
	if (o.tipo === 'panel') {
		if (!direccionPanelValida(o.direccion)) return 'malformed Central address';
		if (
			!Array.isArray(o.antes) ||
			o.antes.length === 0 ||
			o.antes.length > MAX_ANTES ||
			!o.antes.every(direccionReleValida)
		)
			return 'malformed previous Central names';
		if (o.antes.includes(nombrePanel(o.direccion)!))
			return 'the new Central address is one of the previous ones';
		if (!fecha(o.desde) || !fecha(o.caduca)) return 'malformed validity dates';
		if (Date.parse(o.caduca) <= Date.parse(o.desde)) return 'malformed validity dates';
		if (Date.parse(o.caduca) - Date.parse(o.emitida) > MAX_VIDA_ORDEN_PANEL)
			return 'a Central address order cannot last more than 90 days';
		if (o.clavesPanel !== undefined && motivoClavesPanel(o.clavesPanel))
			return motivoClavesPanel(o.clavesPanel);
		return null;
	}
	if (o.tipo === 'recuperacion') {
		if (typeof o.cliente !== 'string' || !ID.test(o.cliente)) return 'malformed customer';
		if (typeof o.id !== 'string' || !UUID.test(o.id)) return 'malformed recovery id';
		if (typeof o.usuario !== 'string' || !USUARIO.test(o.usuario)) return 'malformed user';
		if (typeof o.codigoHash !== 'string' || !HASH.test(o.codigoHash)) return 'malformed code hash';
		if (!fecha(o.caduca)) return 'malformed expiry date';
		if (Date.parse(o.caduca) - Date.parse(o.emitida) > MAX_VIDA_RECUPERACION)
			return 'a recovery code cannot last more than a day';
		return null;
	}
	return 'unknown order type';
}

/* El texto que se firma: lo construyen igual el panel y la herramienta. */
export const textoOrden = (o: Orden) => JSON.stringify(o);

/*
 * Firma (de una clave de uso `delegaciones` o de la de legado), forma y tipo. La caducidad de
 * un código de recuperación y la ventana de una orden del panel las mira quien las guarda, con
 * su reloj (motivoOrdenPanelAqui).
 */
export function verificarOrden<T extends Orden['tipo']>(
	clave: string | Confianza,
	f: unknown,
	tipo: T
): { ok: true; orden: Extract<Orden, { tipo: T }> } | { ok: false; motivo: string } {
	const x = f as OrdenFirmada;
	if (
		!x ||
		typeof x !== 'object' ||
		typeof x.orden !== 'string' ||
		x.orden.length > 4096 ||
		typeof x.firma !== 'string' ||
		motivoFirmas(x.firmas)
	)
		return { ok: false, motivo: 'does not have the form of a signed order' };
	const confianza = aConfianza(clave);
	if (!hayClave(confianza, 'delegaciones'))
		return { ok: false, motivo: 'there is no trusted key to check the order' };
	if (!firmadoPor(confianza, 'delegaciones', x.orden, x.firma, x.firmas))
		return { ok: false, motivo: 'the order is not signed with a SeguridadSI publication key' };
	let o: unknown;
	try {
		o = JSON.parse(x.orden);
	} catch {
		return { ok: false, motivo: 'the signed content is not JSON' };
	}
	const m = motivoOrden(o);
	if (m) return { ok: false, motivo: m };
	if ((o as Orden).tipo !== tipo) return { ok: false, motivo: `not a ${tipo} order` };
	return { ok: true, orden: o as Extract<Orden, { tipo: T }> };
}
