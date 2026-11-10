/*
 * En qué claves de publicación se confía, y para qué (docs/diseno/claves-y-catalogo.md,
 * SUP-1). Cuatro usos, cada uno con sus claves (la principal y la de reserva), más la
 * clave de legado, la de siempre, que vale para todos mientras no se retire.
 *
 * Se dice en dos variables, en el .env del nodo y del sensor remoto, en el panel y en el
 * binario de las trampas de pago:
 *   PUBLICACION_CLAVES         uso:clave,uso:clave,…   (clave: spki DER en base64)
 *   PUBLICACION_CLAVE_PUBLICA  la de legado; vacía, retirada.
 *
 * Un documento firmado (versión, licencia, delegación, appliance) lleva su `firma` de
 * siempre y, opcionalmente, `firmas: [{ clave: huella, firma }]`. Vale si alguna de esas
 * firmas es de una clave en la que se confía para su uso. En la transición, `firma` va con
 * la de legado (la única que entiende lo instalado antes) y `firmas` con la nueva.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const USOS = ['cloud', 'community', 'licencias', 'delegaciones'] as const;
export type Uso = (typeof USOS)[number];

export type ClaveDeConfianza = { uso: Uso; publica: string };
export type Confianza = { claves: ClaveDeConfianza[]; legado: string | null };
export type Firma = { clave: string; firma: string };

/* Huella corta de una clave pública (la misma que huella() de index.ts). */
export const huellaDe = (publicaB64: string) =>
	createHash('sha256').update(Buffer.from(publicaB64, 'base64')).digest('hex').slice(0, 16);

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CLAVES = 16;
const esUso = (x: string): x is Uso => (USOS as readonly string[]).includes(x);

/*
 * Una clave pública de verdad, o null: Ed25519 (la de legado y las de reserva, en fichero) o
 * ECDSA P-256 (las principales, en el HSM del Key Vault de Azure, que no firma con Ed25519).
 */
function publicaValida(b64: string) {
	if (!B64.test(b64) || b64.length > 200) return null;
	try {
		const k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
		if (k.asymmetricKeyType === 'ed25519') return k;
		if (k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1')
			return k;
		return null;
	} catch {
		return null;
	}
}

/* Qué falla en un texto con el formato de PUBLICACION_CLAVES, o null si vale (vacío vale). */
export function motivoClaves(texto: string): string | null {
	if (typeof texto !== 'string') return 'the key list is not text';
	if (texto.trim() === '') return null;
	const partes = texto.split(',');
	if (partes.length > MAX_CLAVES) return `more than ${MAX_CLAVES} trusted keys`;
	for (const p of partes) {
		const i = p.indexOf(':');
		const uso = p.slice(0, i).trim();
		if (i < 0 || !esUso(uso)) return `unknown key use in "${p.slice(0, 20)}"`;
		if (!publicaValida(p.slice(i + 1).trim()))
			return `the ${uso} key is not an Ed25519 or ECDSA P-256 public key`;
	}
	return null;
}

/* Lee las dos variables. Lo que no se entiende se ignora: nunca da más confianza de la dicha. */
export function leerConfianza(claves?: string | null, legado?: string | null): Confianza {
	const lista: ClaveDeConfianza[] = [];
	for (const p of (claves ?? '').split(',')) {
		const i = p.indexOf(':');
		if (i < 0) continue;
		const uso = p.slice(0, i).trim();
		const publica = p.slice(i + 1).trim();
		if (
			esUso(uso) &&
			publicaValida(publica) &&
			!lista.some((c) => c.publica === publica && c.uso === uso)
		)
			lista.push({ uso, publica });
	}
	const l = (legado ?? '').trim();
	return { claves: lista.slice(0, MAX_CLAVES), legado: l && publicaValida(l) ? l : null };
}

/* La confianza que dice un entorno (process.env o el de SvelteKit). */
export const confianzaDelEntorno = (env: Record<string, string | undefined>) =>
	leerConfianza(env.PUBLICACION_CLAVES, env.PUBLICACION_CLAVE_PUBLICA);

/* Una clave suelta, como se pasaba antes: la de legado, válida para todo. */
export const aConfianza = (x: string | Confianza): Confianza =>
	typeof x === 'string' ? { claves: [], legado: x || null } : x;

/* Si se confía en algo para este uso (sin claves, nada se puede comprobar). */
export const hayClave = (c: Confianza, uso: Uso | null) =>
	c.legado !== null || (uso !== null && c.claves.some((k) => k.uso === uso));

export const textoClaves = (claves: ClaveDeConfianza[]) =>
	claves.map((c) => `${c.uso}:${c.publica}`).join(',');

/*
 * Ed25519 sobre el texto; ECDSA P-256 con SHA-256 y la firma en r||s de 64 bytes (IEEE P1363),
 * que es como la devuelve el Key Vault (ES256). Una firma ECDSA en DER no se acepta: una sola
 * forma, la misma que comprueba el Go.
 */
export function firmaValida(publicaB64: string, texto: string, firma: string): boolean {
	try {
		const k = publicaValida(publicaB64);
		if (!k) return false;
		const f = Buffer.from(firma, 'base64');
		if (k.asymmetricKeyType === 'ed25519') return verify(null, Buffer.from(texto), k, f);
		if (f.length !== 64) return false;
		return verify('sha256', Buffer.from(texto), { key: k, dsaEncoding: 'ieee-p1363' }, f);
	} catch {
		return false;
	}
}
const valida = firmaValida;

/*
 * Quien firma: su clave pública y cómo firma un texto (devuelve la firma en base64). Una
 * clave en fichero (Ed25519) o una del Key Vault (herramientas/firmantes.ts, ES256).
 */
export type Firmante = { publica: string; firmar: (texto: string) => string };

/* Un firmante con una privada Ed25519 en pkcs8 DER base64 (sin pública, se saca de ella). */
export const firmanteDePrivada = (privada: string, publica?: string): Firmante => ({
	publica:
		publica ??
		createPublicKey(
			createPrivateKey({ key: Buffer.from(privada, 'base64'), format: 'der', type: 'pkcs8' })
		)
			.export({ format: 'der', type: 'spki' })
			.toString('base64'),
	firmar: (texto) =>
		sign(
			null,
			Buffer.from(texto),
			createPrivateKey({ key: Buffer.from(privada, 'base64'), format: 'der', type: 'pkcs8' })
		).toString('base64')
});

/*
 * `firma` con el principal y `firmas` con los demás: lo que va junto al texto de cualquier
 * documento firmado. Cada firma se comprueba al momento con su pública: si el Key Vault o un
 * fichero devolviera algo que no cuadra, no sale nada firmado.
 */
export function firmarCon(
	texto: string,
	principal: Firmante,
	extra: readonly Firmante[] = []
): { firma: string; firmas?: Firma[] } {
	const firmarYComprobar = (f: Firmante) => {
		const firma = f.firmar(texto);
		if (!firmaValida(f.publica, texto, firma))
			throw new Error(`la firma de la clave ${huellaDe(f.publica)} no se comprueba`);
		return firma;
	};
	const firma = firmarYComprobar(principal);
	return {
		firma,
		...(extra.length
			? { firmas: extra.map((f) => ({ clave: huellaDe(f.publica), firma: firmarYComprobar(f) })) }
			: {})
	};
}

/*
 * La huella de la clave en la que se confía que firmó este texto para este uso, o null.
 * `firma` se comprueba con la de legado y con las del uso; cada una de `firmas`, con la
 * clave de su huella (si es del uso o la de legado). uso null (una versión de un registro
 * que no es ni de Cloud ni de Community): solo la de legado.
 */
export function firmadoPor(
	c: Confianza,
	uso: Uso | null,
	texto: string,
	firma: unknown,
	firmas?: unknown
): string | null {
	const candidatas = [
		...(c.legado ? [c.legado] : []),
		...(uso ? c.claves.filter((k) => k.uso === uso).map((k) => k.publica) : [])
	];
	if (typeof firma === 'string')
		for (const p of candidatas) if (valida(p, texto, firma)) return huellaDe(p);
	if (Array.isArray(firmas))
		for (const f of firmas.slice(0, 8) as Partial<Firma>[]) {
			if (!f || typeof f.clave !== 'string' || typeof f.firma !== 'string') continue;
			const p = candidatas.find((k) => huellaDe(k) === f.clave);
			if (p && valida(p, texto, f.firma)) return huellaDe(p);
		}
	return null;
}

/* Las firmas que se añaden a `firmas` con las claves nuevas (privada pkcs8 y su pública). */
export function firmasExtra(
	texto: string,
	claves: readonly { privada: string; publica: string }[]
): Firma[] {
	return claves.map((k) => ({
		clave: huellaDe(k.publica),
		firma: sign(
			null,
			Buffer.from(texto),
			createPrivateKey({ key: Buffer.from(k.privada, 'base64'), format: 'der', type: 'pkcs8' })
		).toString('base64')
	}));
}

/* Qué falla en una lista de firmas recibida (forma), o null. */
export function motivoFirmas(x: unknown): string | null {
	if (x === undefined) return null;
	if (!Array.isArray(x) || x.length > 8) return 'malformed signature list';
	for (const f of x as Partial<Firma>[])
		if (
			!f ||
			typeof f.clave !== 'string' ||
			!/^[0-9a-f]{16}$/.test(f.clave) ||
			typeof f.firma !== 'string' ||
			!B64.test(f.firma)
		)
			return 'malformed signature list';
	return null;
}
