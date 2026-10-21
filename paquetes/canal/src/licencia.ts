/*
 * La licencia de las trampas de pago (docs/diseno/licencias-de-pago.md).
 *
 * Es un permiso firmado por cliente/nodo: dice qué módulos de pago puede correr
 * ese nodo y hasta cuándo. Se firma con la CLAVE DE PUBLICACIÓN (la misma de las
 * versiones y el appliance, huella 42c2e2242a8ec947), que no vive en el panel:
 * así, quien tome el panel no puede forjar licencias de módulos que no ha
 * pagado. La verifica, con esa misma clave pública EMBEBIDA, el binario cerrado
 * de cada trampa de pago al arrancar (modulos/comun/licencia), que es quien
 * tiene los dientes: la consola y el sensor son de código abierto y no bastan.
 *
 * Lleva "tipo" para que una versión del nodo o un appliance firmados con la
 * misma clave no puedan hacerse pasar por una licencia, ni al revés (igual que
 * hace appliance.ts). No es secreta: es un permiso firmado, no una contraseña.
 *
 * Se firma el TEXTO JSON exacto, no un objeto: lo que verifica la trampa es lo
 * que se firmó, sin depender de cómo se serialice. El gemelo en Go
 * (modulos/comun/licencia/licencia.go) verifica ese mismo texto y lo parsea; no
 * vuelve a serializar, así que no hay que canonicalizar nada entre lenguajes.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export type Licencia = {
	tipo: 'licencia';
	version: 1;
	/* Cliente al que se le emite (clientes.id del panel). */
	cliente: string;
	/* Nodo al que va ligada (nodos.id del panel). */
	nodo: string;
	/* Clave pública del nodo (spki DER en base64): a qué nodo pertenece. */
	nodoClave: string;
	/* Módulos (de pago) que este nodo puede correr. Un id de honeycosa por entrada. */
	modulos: string[];
	/* Marcador por cliente (marca de agua): delata de quién salió una copia. */
	marca: string;
	emitida: string;
	caduca: string;
};

export type LicenciaFirmada = { licencia: string; firma: string };

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MODULO = /^[a-z0-9][a-z0-9-]{0,62}$/;
const B64 = /^[A-Za-z0-9+/]+=*$/;

const privada = (b64: string) =>
	createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
const publica = (b64: string) =>
	createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

export function firmarLicencia(clavePrivada: string, l: Licencia): LicenciaFirmada {
	const texto = JSON.stringify(l);
	return {
		licencia: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64')
	};
}

/* Qué falla en una licencia ya parseada, o null si su forma vale. No mira firma ni reloj. */
export function motivoLicencia(x: unknown): string | null {
	const l = x as Licencia;
	if (!l || typeof l !== 'object' || l.tipo !== 'licencia') return 'no es una licencia';
	if (l.version !== 1) return 'versión de licencia desconocida';
	if (typeof l.cliente !== 'string' || !ID.test(l.cliente)) return 'cliente mal formado';
	if (typeof l.nodo !== 'string' || !ID.test(l.nodo)) return 'nodo mal formado';
	if (typeof l.nodoClave !== 'string' || !B64.test(l.nodoClave))
		return 'clave del nodo mal formada';
	if (!Array.isArray(l.modulos) || l.modulos.some((m) => typeof m !== 'string' || !MODULO.test(m)))
		return 'lista de módulos mal formada';
	if (typeof l.marca !== 'string' || l.marca.length === 0 || l.marca.length > 128)
		return 'marca mal formada';
	if (typeof l.emitida !== 'string' || !Number.isFinite(Date.parse(l.emitida)))
		return 'fecha de emisión mal formada';
	if (typeof l.caduca !== 'string' || !Number.isFinite(Date.parse(l.caduca)))
		return 'fecha de caducidad mal formada';
	return null;
}

/*
 * Verifica firma, forma y que no esté caducada. No comprueba el módulo ni el
 * nodo: eso lo decide quien llama (la trampa, con su propio id; el panel, al
 * cotejar el nodo). Devuelve la licencia parseada si todo cuadra.
 */
export function verificarLicencia(
	clavePublicaPublicacion: string,
	f: unknown,
	ahora: number = Date.now()
): { ok: true; licencia: Licencia } | { ok: false; motivo: string } {
	const x = f as LicenciaFirmada;
	if (!x || typeof x !== 'object' || typeof x.licencia !== 'string' || typeof x.firma !== 'string')
		return { ok: false, motivo: 'no tiene la forma de una licencia firmada' };
	let valida = false;
	try {
		valida = verify(
			null,
			Buffer.from(x.licencia),
			publica(clavePublicaPublicacion),
			Buffer.from(x.firma, 'base64')
		);
	} catch {
		valida = false;
	}
	if (!valida) return { ok: false, motivo: 'no está firmada por SeguridadSI' };
	let l: unknown;
	try {
		l = JSON.parse(x.licencia);
	} catch {
		return { ok: false, motivo: 'lo firmado no es JSON' };
	}
	const m = motivoLicencia(l);
	if (m) return { ok: false, motivo: m };
	if (Date.parse((l as Licencia).caduca) < ahora) return { ok: false, motivo: 'licencia caducada' };
	return { ok: true, licencia: l as Licencia };
}

/* Si una licencia ya verificada incluye ese módulo de pago. */
export function licenciaPermite(l: Licencia, modulo: string): boolean {
	return l.modulos.includes(modulo);
}
