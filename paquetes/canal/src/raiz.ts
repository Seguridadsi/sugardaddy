/*
 * La raíz de firma (docs/diseno/firmas-raiz.md, revisión del 2026-11-14, R4-A). Formato
 * listo, sin usar todavía: ningún nodo lo exige.
 *
 * El modelo es el de TUF: unas pocas claves raíz, fuera de línea (dos llaves físicas), firman
 * un documento con caducidad que dice cuáles son las claves de trabajo (las de los cuatro usos
 * y las de las marcas de tiempo). Las de trabajo viven en el Key Vault y se pueden rotar con
 * un documento nuevo; la raíz solo se saca del cajón para eso, una vez al año o si algo cae.
 *
 *   { tipo: 'raiz', version, emitida, caduca,
 *     raiz:   { claves: [pública, …], umbral },   quién firma la raíz siguiente
 *     claves: "<formato de PUBLICACION_CLAVES>",  las de trabajo de los cuatro usos
 *     marcas: "<formato de PUBLICACION_MARCAS>" } las de la marca de tiempo
 *
 * Vale si la firman al menos `umbral` claves distintas de la raíz en la que ya se confía. Una
 * raíz de versión mayor (rotación) tiene que venir firmada además por `umbral` de las suyas:
 * así nadie la cambia con las viejas solas ni con las nuevas solas. Nunca se acepta una
 * versión menor que la conocida (vuelta atrás) ni una caducada (las claves de trabajo caducan
 * con ella). El gemelo en Go está en sensor/internal/actualizador/raiz.go.
 */
import {
	esClaveVerificable,
	firmaValida,
	huellaDe,
	leerClavesMarca,
	motivoClaves,
	motivoClavesMarca,
	type Firma,
	type Firmante
} from './confianza.ts';

export type Raiz = {
	tipo: 'raiz';
	version: number;
	emitida: string;
	caduca: string;
	raiz: { claves: string[]; umbral: number };
	claves: string;
	marcas: string;
};

export type RaizFirmada = { raiz: string; firmas: Firma[] };

/* En qué raíz se confía: sus claves, cuántas hacen falta y la versión ya vista. */
export type RaizDeConfianza = { claves: string[]; umbral: number; version: number };

const MAX_RAICES = 8;

/*
 * La raíz en la que se confía, dicha en una variable (PUBLICACION_RAIZ):
 * "<umbral>:<pública>,<pública>,…". null si no se entiende o el umbral no cuadra.
 */
export function leerRaizDeConfianza(texto?: string | null, version = 0): RaizDeConfianza | null {
	const m = /^\s*(\d+)\s*:(.*)$/s.exec(texto ?? '');
	if (!m) return null;
	const claves = leerClavesMarca(m[2]);
	const umbral = Number(m[1]);
	if (umbral < 1 || umbral > claves.length) return null;
	return { claves, umbral, version };
}

function motivoForma(r: Raiz): string | null {
	if (!r || typeof r !== 'object' || r.tipo !== 'raiz') return 'it is not a root document';
	if (!Number.isSafeInteger(r.version) || r.version < 1) return 'malformed root version';
	if (!Number.isFinite(Date.parse(r.emitida)) || !Number.isFinite(Date.parse(r.caduca)))
		return 'malformed root dates';
	const k = r.raiz?.claves;
	if (
		!Array.isArray(k) ||
		k.length === 0 ||
		k.length > MAX_RAICES ||
		!k.every(esClaveVerificable) ||
		new Set(k).size !== k.length
	)
		return 'malformed root keys';
	if (!Number.isSafeInteger(r.raiz.umbral) || r.raiz.umbral < 1 || r.raiz.umbral > k.length)
		return 'malformed root threshold';
	if (typeof r.claves !== 'string' || typeof r.marcas !== 'string') return 'malformed working keys';
	return motivoClaves(r.claves) ?? motivoClavesMarca(r.marcas);
}

/* Cuántas claves distintas de `claves` firmaron el texto. */
function cuantasFirman(claves: readonly string[], texto: string, firmas: unknown) {
	if (!Array.isArray(firmas)) return 0;
	const vistas = new Set<string>();
	for (const f of firmas.slice(0, 16) as Partial<Firma>[]) {
		if (!f || typeof f.clave !== 'string' || typeof f.firma !== 'string') continue;
		const p = claves.find((c) => huellaDe(c) === f.clave);
		if (p && !vistas.has(f.clave) && firmaValida(p, texto, f.firma)) vistas.add(f.clave);
	}
	return vistas.size;
}

export function verificarRaiz(
	conf: RaizDeConfianza,
	f: RaizFirmada,
	ahora = Date.now()
): { ok: true; raiz: Raiz; confianza: RaizDeConfianza } | { ok: false; motivo: string } {
	if (!f || typeof f.raiz !== 'string' || !Array.isArray(f.firmas))
		return { ok: false, motivo: 'does not have the form of a signed root' };
	let r: Raiz;
	try {
		r = JSON.parse(f.raiz) as Raiz;
	} catch {
		return { ok: false, motivo: 'it is not a root document' };
	}
	const m = motivoForma(r);
	if (m) return { ok: false, motivo: m };
	if (r.version < conf.version)
		return { ok: false, motivo: `root version ${r.version} is older than ${conf.version}` };
	if (cuantasFirman(conf.claves, f.raiz, f.firmas) < conf.umbral)
		return { ok: false, motivo: 'not enough signatures from the trusted root' };
	if (r.version > conf.version && cuantasFirman(r.raiz.claves, f.raiz, f.firmas) < r.raiz.umbral)
		return { ok: false, motivo: 'the new root is not signed by its own keys' };
	if (Date.parse(r.caduca) <= ahora) return { ok: false, motivo: 'the root has expired' };
	return {
		ok: true,
		raiz: r,
		confianza: { claves: r.raiz.claves, umbral: r.raiz.umbral, version: r.version }
	};
}

/* Firma una raíz con cada una de las llaves que se presenten (cada una, en `firmas`). */
export function firmarRaiz(r: Raiz, firmantes: readonly Firmante[]): RaizFirmada {
	const m = motivoForma(r);
	if (m) throw new Error(m);
	const texto = JSON.stringify(r);
	return {
		raiz: texto,
		firmas: firmantes.map((k) => {
			const firma = k.firmar(texto);
			if (!firmaValida(k.publica, texto, firma))
				throw new Error(`la firma de la llave ${huellaDe(k.publica)} no se comprueba`);
			return { clave: huellaDe(k.publica), firma };
		})
	};
}
