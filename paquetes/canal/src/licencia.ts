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
 *
 * Certificado de MSP (docs/diseno/msp.md): la clave de publicación no sale de
 * donde está, y firma un certificado que autoriza a la clave de un MSP a firmar
 * licencias de unos módulos hasta una fecha. La licencia lleva ese certificado
 * adjunto, y quien verifica sigue la cadena desde la clave de publicación. Sirve
 * solo para licencias: las versiones se siguen verificando únicamente con la
 * clave de publicación, así que un MSP nunca puede firmar una versión.
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

/* Autoriza a la clave de un MSP a firmar licencias de esos módulos hasta esa fecha. */
export type Delegacion = {
	tipo: 'delegacion-licencias';
	version: 1;
	/* Quién es el MSP (el id que le da la central de SeguridadSI). */
	msp: string;
	/* Su clave pública (spki DER en base64): la que firma sus licencias. */
	clavePublica: string;
	/* Los módulos de pago que puede licenciar. */
	modulos: string[];
	emitida: string;
	caduca: string;
};

export type DelegacionFirmada = { delegacion: string; firma: string };

/* Sin delegacion, firmada con la clave de publicación; con ella, con la del MSP. */
export type LicenciaFirmada = { licencia: string; firma: string; delegacion?: DelegacionFirmada };

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

/* El certificado de un MSP, firmado con la clave de publicación. */
export function firmarDelegacion(clavePrivada: string, d: Delegacion): DelegacionFirmada {
	const texto = JSON.stringify(d);
	return {
		delegacion: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivada)).toString('base64')
	};
}

/* Una licencia firmada por un MSP, con su certificado adjunto. */
export function firmarLicenciaDelegada(
	clavePrivadaMsp: string,
	l: Licencia,
	delegacion: DelegacionFirmada
): LicenciaFirmada {
	return { ...firmarLicencia(clavePrivadaMsp, l), delegacion };
}

/* Con hora y zona (RFC 3339): las trampas, en Go, no admiten otra cosa. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const fechaValida = (v: unknown) =>
	typeof v === 'string' && RFC3339.test(v) && Number.isFinite(Date.parse(v));

function motivoDelegacion(x: unknown): string | null {
	const d = x as Delegacion;
	if (!d || typeof d !== 'object' || d.tipo !== 'delegacion-licencias')
		return 'not an MSP certificate';
	if (d.version !== 1) return 'unknown certificate version';
	if (typeof d.msp !== 'string' || !ID.test(d.msp)) return 'malformed MSP';
	if (typeof d.clavePublica !== 'string' || !B64.test(d.clavePublica)) return 'malformed MSP key';
	if (!Array.isArray(d.modulos) || d.modulos.some((m) => typeof m !== 'string' || !MODULO.test(m)))
		return 'malformed certificate module list';
	if (!fechaValida(d.emitida)) return 'malformed certificate issue date';
	if (!fechaValida(d.caduca)) return 'malformed certificate expiry date';
	return null;
}

/* Firma (de la clave de publicación), forma y caducidad del certificado de un MSP. */
export function verificarDelegacion(
	clavePublicaPublicacion: string,
	f: unknown,
	ahora: number = Date.now()
): { ok: true; delegacion: Delegacion } | { ok: false; motivo: string } {
	const x = f as DelegacionFirmada;
	if (
		!x ||
		typeof x !== 'object' ||
		typeof x.delegacion !== 'string' ||
		typeof x.firma !== 'string'
	)
		return { ok: false, motivo: 'does not have the form of a signed certificate' };
	if (!firmaValida(clavePublicaPublicacion, x.delegacion, x.firma))
		return { ok: false, motivo: 'the certificate is not signed by SeguridadSI' };
	let d: unknown;
	try {
		d = JSON.parse(x.delegacion);
	} catch {
		return { ok: false, motivo: 'the signed content is not JSON' };
	}
	const m = motivoDelegacion(d);
	if (m) return { ok: false, motivo: m };
	if (Date.parse((d as Delegacion).caduca) < ahora)
		return { ok: false, motivo: 'the MSP certificate has expired' };
	return { ok: true, delegacion: d as Delegacion };
}

const firmaValida = (clave: string, texto: string, firma: string) => {
	try {
		return verify(null, Buffer.from(texto), publica(clave), Buffer.from(firma, 'base64'));
	} catch {
		return false;
	}
};

/* Qué falla en una licencia ya parseada, o null si su forma vale. No mira firma ni reloj. */
export function motivoLicencia(x: unknown): string | null {
	const l = x as Licencia;
	if (!l || typeof l !== 'object' || l.tipo !== 'licencia') return 'not a license';
	if (l.version !== 1) return 'unknown license version';
	if (typeof l.cliente !== 'string' || !ID.test(l.cliente)) return 'malformed customer';
	if (typeof l.nodo !== 'string' || !ID.test(l.nodo)) return 'malformed node';
	if (typeof l.nodoClave !== 'string' || !B64.test(l.nodoClave)) return 'malformed node key';
	if (!Array.isArray(l.modulos) || l.modulos.some((m) => typeof m !== 'string' || !MODULO.test(m)))
		return 'malformed module list';
	if (typeof l.marca !== 'string' || l.marca.length === 0 || l.marca.length > 128)
		return 'malformed brand';
	if (!fechaValida(l.emitida)) return 'malformed issue date';
	if (!fechaValida(l.caduca)) return 'malformed expiry date';
	return null;
}

/*
 * Verifica firma, forma y que no esté caducada. No comprueba el módulo ni el
 * nodo: eso lo decide quien llama (la trampa, con su propio id; el panel, al
 * cotejar el nodo). Devuelve la licencia parseada si todo cuadra. Con un
 * certificado de MSP adjunto, sigue la cadena: el certificado tiene que valer
 * con la clave de publicación, y la licencia, estar firmada por la clave del
 * certificado y no pasar de sus módulos. msp: de quién es, si es de un MSP.
 */
export function verificarLicencia(
	clavePublicaPublicacion: string,
	f: unknown,
	ahora: number = Date.now()
): { ok: true; licencia: Licencia; msp?: string } | { ok: false; motivo: string } {
	const x = f as LicenciaFirmada;
	if (!x || typeof x !== 'object' || typeof x.licencia !== 'string' || typeof x.firma !== 'string')
		return { ok: false, motivo: 'does not have the form of a signed license' };
	let clave = clavePublicaPublicacion;
	let delegada: Delegacion | null = null;
	if (x.delegacion !== undefined) {
		const d = verificarDelegacion(clavePublicaPublicacion, x.delegacion, ahora);
		if (!d.ok) return { ok: false, motivo: d.motivo };
		delegada = d.delegacion;
		clave = delegada.clavePublica;
	}
	if (!firmaValida(clave, x.licencia, x.firma))
		return {
			ok: false,
			motivo: delegada ? 'not signed by the MSP key' : 'not signed by SeguridadSI'
		};
	let l: unknown;
	try {
		l = JSON.parse(x.licencia);
	} catch {
		return { ok: false, motivo: 'the signed content is not JSON' };
	}
	const m = motivoLicencia(l);
	if (m) return { ok: false, motivo: m };
	if (Date.parse((l as Licencia).caduca) < ahora) return { ok: false, motivo: 'license expired' };
	if (delegada) {
		const permitidos = new Set(delegada.modulos);
		const fuera = (l as Licencia).modulos.find((n) => !permitidos.has(n));
		if (fuera) return { ok: false, motivo: `the MSP certificate does not include "${fuera}"` };
		return { ok: true, licencia: l as Licencia, msp: delegada.msp };
	}
	return { ok: true, licencia: l as Licencia };
}

/* Si una licencia ya verificada incluye ese módulo de pago. */
export function licenciaPermite(l: Licencia, modulo: string): boolean {
	return l.modulos.includes(modulo);
}
