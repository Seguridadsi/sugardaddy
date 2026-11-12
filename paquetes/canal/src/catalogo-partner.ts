/*
 * Trampas de partner (docs/diseno/trampas-de-partner.md).
 *
 * Un partner desarrolla sus trampas, las firma él y solo las arrancan los nodos de sus
 * empresas. La cadena cuelga de SeguridadSI, como la de las licencias de un MSP:
 *
 *   1. SeguridadSI firma, con una clave de uso «delegaciones», un certificado que dice
 *      qué clave del partner puede firmar trampas, con qué prefijo y hasta cuándo.
 *   2. El partner firma con esa clave su catálogo: las huellas de los manifiestos de
 *      sus trampas, las mismas que calcula el sensor (sensor/cmd/catalogo).
 *   3. El sensor comprueba la cadena, que el partner sea el de su nodo y que la trampa
 *      lleve el prefijo (sensor/internal/catalogo/partner.go, el gemelo de esto).
 *
 * El certificado lleva su propio «tipo»: uno de licencias no vale para firmar trampas,
 * ni al revés, aunque los firme la misma clave.
 *
 * Como en licencia.ts, se firma el TEXTO JSON exacto y quien verifica lo parsea sin
 * volver a serializarlo.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import {
	aConfianza,
	firmadoPor,
	firmaValida,
	hayClave,
	motivoFirmas,
	type Confianza,
	type Firma
} from './confianza.ts';

export type DelegacionCatalogo = {
	tipo: 'delegacion-catalogo';
	version: 1;
	/* Quién es el partner: el mismo id que su certificado de licencias. */
	msp: string;
	/* Su clave de trampas (spki DER en base64). No es la de su central. */
	clavePublica: string;
	/* Los ids de sus trampas son `<prefijo>-<algo>`. */
	prefijo: string;
	emitida: string;
	caduca: string;
};

export type DelegacionCatalogoFirmada = { delegacion: string; firma: string; firmas?: Firma[] };

export type CatalogoPartner = {
	tipo: 'catalogo-partner';
	version: 1;
	msp: string;
	/* Sube con cada catálogo: el sensor no acepta uno con una serie menor que la última. */
	serie: number;
	emitida: string;
	/* Por módulo, las huellas de sus manifiestos (sha256 en hex, del Go del sensor). */
	catalogo: Record<string, string[]>;
	/*
	 * Por módulo, el sha256 de su trampa.yaml. La huella de arriba fija lo que corre en el
	 * sensor; esta fija lo demás que lee la consola (la ficha, los parámetros): quien
	 * reparte el catálogo no puede cambiar ni una letra de lo que firmó el partner.
	 */
	fuentes: Record<string, string>;
};

export type CatalogoPartnerFirmado = {
	catalogo: string;
	firma: string;
	delegacion: DelegacionCatalogoFirmada;
};

/*
 * Lo que el partner sube a su central y esta reparte a las consolas de sus empresas: el
 * catálogo firmado y el texto de cada trampa.yaml. El sensor solo recibe `firmado`.
 */
export type PaquetePartner = {
	firmado: CatalogoPartnerFirmado;
	manifiestos: Record<string, string>;
};

/* Lo que puede pesar un paquete entero y cada manifiesto. */
export const MAX_PAQUETE_PARTNER = 4 * 1024 * 1024;
export const MAX_MANIFIESTO_PARTNER = 256 * 1024;

export const huellaDeFuente = (yaml: string) => createHash('sha256').update(yaml).digest('hex');

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/* Sin guiones: así `acme` nunca es a la vez prefijo de `acme-x-…` de otro partner. */
export const PREFIJO_PARTNER = /^[a-z0-9]{3,20}$/;
const B64 = /^[A-Za-z0-9+/]+=*$/;
const HUELLA = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const fechaValida = (v: unknown) =>
	typeof v === 'string' && RFC3339.test(v) && Number.isFinite(Date.parse(v));

/* Topes, los mismos que aplica el sensor: nadie necesita más y acotan lo que se lee. */
export const MAX_MODULOS_PARTNER = 200;
export const MAX_HUELLAS_POR_MODULO = 8;

const privada = (b64: string) =>
	createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });

function motivoDelegacionCatalogo(x: unknown): string | null {
	const d = x as DelegacionCatalogo;
	if (!d || typeof d !== 'object' || d.tipo !== 'delegacion-catalogo')
		return 'not a partner decoy certificate';
	if (d.version !== 1) return 'unknown certificate version';
	if (typeof d.msp !== 'string' || !ID.test(d.msp)) return 'malformed partner';
	if (typeof d.clavePublica !== 'string' || !B64.test(d.clavePublica))
		return 'malformed partner key';
	if (typeof d.prefijo !== 'string' || !PREFIJO_PARTNER.test(d.prefijo))
		return 'malformed decoy prefix';
	if (!fechaValida(d.emitida)) return 'malformed certificate issue date';
	if (!fechaValida(d.caduca)) return 'malformed certificate expiry date';
	return null;
}

/* Firma (de una clave de uso «delegaciones»), forma y caducidad del certificado. */
export function verificarDelegacionCatalogo(
	clavePublicaPublicacion: string | Confianza,
	f: unknown,
	ahora: number = Date.now()
): { ok: true; delegacion: DelegacionCatalogo } | { ok: false; motivo: string } {
	const x = f as DelegacionCatalogoFirmada;
	if (
		!x ||
		typeof x !== 'object' ||
		typeof x.delegacion !== 'string' ||
		typeof x.firma !== 'string' ||
		motivoFirmas(x.firmas)
	)
		return { ok: false, motivo: 'does not have the form of a signed certificate' };
	const confianza = aConfianza(clavePublicaPublicacion);
	if (!hayClave(confianza, 'delegaciones'))
		return { ok: false, motivo: 'there is no trusted key to check the certificate' };
	if (!firmadoPor(confianza, 'delegaciones', x.delegacion, x.firma, x.firmas))
		return { ok: false, motivo: 'the certificate is not signed by SeguridadSI' };
	let d: unknown;
	try {
		d = JSON.parse(x.delegacion);
	} catch {
		return { ok: false, motivo: 'the signed content is not JSON' };
	}
	const m = motivoDelegacionCatalogo(d);
	if (m) return { ok: false, motivo: m };
	if (Date.parse((d as DelegacionCatalogo).caduca) < ahora)
		return { ok: false, motivo: 'the partner decoy certificate has expired' };
	return { ok: true, delegacion: d as DelegacionCatalogo };
}

/* Qué falla en un catálogo ya parseado, o null. No mira firma ni prefijo. */
export function motivoCatalogoPartner(x: unknown): string | null {
	const c = x as CatalogoPartner;
	if (!c || typeof c !== 'object' || c.tipo !== 'catalogo-partner') return 'not a partner catalog';
	if (c.version !== 1) return 'unknown catalog version';
	if (typeof c.msp !== 'string' || !ID.test(c.msp)) return 'malformed partner';
	if (!Number.isSafeInteger(c.serie) || c.serie < 1) return 'malformed serial number';
	if (!fechaValida(c.emitida)) return 'malformed catalog issue date';
	if (!c.catalogo || typeof c.catalogo !== 'object' || Array.isArray(c.catalogo))
		return 'malformed catalog';
	const modulos = Object.entries(c.catalogo);
	if (modulos.length > MAX_MODULOS_PARTNER) return 'too many decoys in the catalog';
	for (const [id, huellas] of modulos) {
		if (!ID.test(id)) return `malformed decoy identifier "${id}"`;
		if (
			!Array.isArray(huellas) ||
			huellas.length < 1 ||
			huellas.length > MAX_HUELLAS_POR_MODULO ||
			huellas.some((h) => typeof h !== 'string' || !HUELLA.test(h))
		)
			return `malformed fingerprints for "${id}"`;
	}
	if (!c.fuentes || typeof c.fuentes !== 'object' || Array.isArray(c.fuentes))
		return 'malformed source fingerprints';
	const fuentes = Object.entries(c.fuentes);
	if (fuentes.length !== modulos.length) return 'the source fingerprints do not match the decoys';
	for (const [id, h] of fuentes) {
		if (!Object.hasOwn(c.catalogo, id)) return `source fingerprint of unknown decoy "${id}"`;
		if (typeof h !== 'string' || !HUELLA.test(h)) return `malformed source fingerprint for "${id}"`;
	}
	return null;
}

/* El partner firma su catálogo con su clave de trampas (Ed25519) y adjunta el certificado. */
export function firmarCatalogoPartner(
	clavePrivadaPartner: string,
	c: CatalogoPartner,
	delegacion: DelegacionCatalogoFirmada
): CatalogoPartnerFirmado {
	const texto = JSON.stringify(c);
	return {
		catalogo: texto,
		firma: sign(null, Buffer.from(texto), privada(clavePrivadaPartner)).toString('base64'),
		delegacion
	};
}

/*
 * Sigue la cadena entera: certificado de SeguridadSI, catálogo firmado por la clave del
 * certificado, mismo partner y todos los ids con su prefijo. No mira la serie (eso es
 * del sensor, que recuerda la última) ni de qué partner es el nodo: lo decide quien llama.
 */
export function verificarCatalogoPartner(
	clavePublicaPublicacion: string | Confianza,
	f: unknown,
	ahora: number = Date.now()
):
	| { ok: true; catalogo: CatalogoPartner; delegacion: DelegacionCatalogo }
	| { ok: false; motivo: string } {
	const x = f as CatalogoPartnerFirmado;
	if (!x || typeof x !== 'object' || typeof x.catalogo !== 'string' || typeof x.firma !== 'string')
		return { ok: false, motivo: 'does not have the form of a signed partner catalog' };
	const d = verificarDelegacionCatalogo(clavePublicaPublicacion, x.delegacion, ahora);
	if (!d.ok) return d;
	if (!firmaValida(d.delegacion.clavePublica, x.catalogo, x.firma))
		return { ok: false, motivo: 'the catalog is not signed by the partner key' };
	let c: unknown;
	try {
		c = JSON.parse(x.catalogo);
	} catch {
		return { ok: false, motivo: 'the signed content is not JSON' };
	}
	const m = motivoCatalogoPartner(c);
	if (m) return { ok: false, motivo: m };
	const catalogo = c as CatalogoPartner;
	if (catalogo.msp !== d.delegacion.msp)
		return { ok: false, motivo: 'the catalog and the certificate belong to different partners' };
	const fuera = Object.keys(catalogo.catalogo).find(
		(id) => !id.startsWith(`${d.delegacion.prefijo}-`)
	);
	if (fuera)
		return {
			ok: false,
			motivo: `"${fuera}" does not carry the partner prefix "${d.delegacion.prefijo}-"`
		};
	return { ok: true, catalogo, delegacion: d.delegacion };
}

/*
 * El techo de aislamiento de una trampa de partner. Quien manda es el sensor
 * (sensor/internal/catalogo/partner.go, MotivoTecho): esto es su gemelo, para que el
 * partner se entere al firmar y no al desplegar. Si cambia uno, cambia el otro: las
 * pruebas de los dos lados recorren los mismos casos.
 */
export const TECHO_PARTNER = {
	cpu: 1,
	memoriaMb: 512,
	puertos: 16,
	ficheros: 32,
	escribibles: 8
} as const;

const CON_DIGEST = /@sha256:[0-9a-f]{64}$/;

type Proyectado = {
	contenedor?: {
		imagen?: unknown;
		puertos?: unknown[];
		ficheros?: unknown[];
		escribibles?: unknown[];
	} | null;
	red?: unknown;
	aislamiento?: {
		salida?: unknown;
		soloLectura?: unknown;
		cpu?: unknown;
		memoriaMb?: unknown;
	} | null;
};

/* Por qué ese manifiesto, ya proyectado para el sensor, pasa del techo (null si no pasa). */
export function motivoTechoPartner(manifiesto: unknown): string | null {
	const m = manifiesto as Proyectado;
	const c = m?.contenedor;
	if (!c) return 'a partner decoy must be a container';
	if (typeof c.imagen !== 'string' || !CON_DIGEST.test(c.imagen))
		return 'the image must be pinned by its digest (…@sha256:…)';
	if (m.red != null) return 'partner decoys cannot use the own-IP network mode';
	const a = m.aislamiento;
	if (!a) return 'the isolation block is required';
	if (a.salida) return 'partner decoys may not reach the internet';
	if (a.soloLectura !== true) return 'the container file system must be read-only';
	if (typeof a.cpu !== 'number' || !(a.cpu > 0) || a.cpu > TECHO_PARTNER.cpu)
		return `the CPU limit must be above 0 and at most ${TECHO_PARTNER.cpu}`;
	if (
		typeof a.memoriaMb !== 'number' ||
		!Number.isInteger(a.memoriaMb) ||
		a.memoriaMb < 1 ||
		a.memoriaMb > TECHO_PARTNER.memoriaMb
	)
		return `the memory limit must be between 1 and ${TECHO_PARTNER.memoriaMb} MB`;
	if ((c.puertos?.length ?? 0) > TECHO_PARTNER.puertos)
		return `at most ${TECHO_PARTNER.puertos} ports`;
	if ((c.ficheros?.length ?? 0) > TECHO_PARTNER.ficheros)
		return `at most ${TECHO_PARTNER.ficheros} files`;
	if ((c.escribibles?.length ?? 0) > TECHO_PARTNER.escribibles)
		return `at most ${TECHO_PARTNER.escribibles} writable folders`;
	return null;
}

/*
 * El paquete entero: la cadena del catálogo y que cada manifiesto sea, letra por letra, el
 * que firmó el partner. No lee los manifiestos (eso es del contrato): solo dice que son
 * auténticos.
 */
export function verificarPaquetePartner(
	clavePublicaPublicacion: string | Confianza,
	p: unknown,
	ahora: number = Date.now()
):
	| {
			ok: true;
			catalogo: CatalogoPartner;
			delegacion: DelegacionCatalogo;
			manifiestos: Record<string, string>;
	  }
	| { ok: false; motivo: string } {
	const x = p as PaquetePartner;
	if (
		!x ||
		typeof x !== 'object' ||
		!x.manifiestos ||
		typeof x.manifiestos !== 'object' ||
		Array.isArray(x.manifiestos)
	)
		return { ok: false, motivo: 'does not have the form of a partner package' };
	const v = verificarCatalogoPartner(clavePublicaPublicacion, x.firmado, ahora);
	if (!v.ok) return v;
	const ids = Object.keys(v.catalogo.catalogo);
	const dados = Object.keys(x.manifiestos);
	if (dados.length !== ids.length || dados.some((id) => !Object.hasOwn(v.catalogo.catalogo, id)))
		return { ok: false, motivo: 'the manifests do not match the signed catalog' };
	for (const id of ids) {
		const yaml = x.manifiestos[id];
		if (typeof yaml !== 'string' || yaml.length > MAX_MANIFIESTO_PARTNER)
			return { ok: false, motivo: `malformed manifest for "${id}"` };
		if (huellaDeFuente(yaml) !== v.catalogo.fuentes[id])
			return { ok: false, motivo: `the manifest of "${id}" is not the one the partner signed` };
	}
	return { ok: true, catalogo: v.catalogo, delegacion: v.delegacion, manifiestos: x.manifiestos };
}
