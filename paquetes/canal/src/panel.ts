/*
 * Las claves del panel: con qué firma el panel lo que baja a los nodos (el estado deseado, la
 * lista común y la de Tor) y cómo las rotan los nodos sin reinstalar
 * (docs/diseno/panel-endurecido.md).
 *
 * - El panel firma con la clave del HSM de un Key Vault Premium (ECDSA P-256, ES256, r||s), de
 *   la que nunca sale la privada. Durante la transición firma además con la Ed25519 de antes:
 *   ella en `firma` (la única que entienden los nodos instalados) y la del HSM en `firmas`.
 * - El nodo fijó UNA clave del panel en el alta. Desde aquí guarda una lista, y la lista solo
 *   la cambia una versión firmada con la clave de PUBLICACIÓN (`clavesPanel`), que no vive en
 *   Azure: tomar el panel no basta para meter una clave del panel nueva en los nodos.
 * - Una versión cambia la lista solo de los nodos de ESE panel: los que ya confían en alguna
 *   de sus claves o en alguna de las que sustituye (`reemplaza`, huellas). Un nodo de la
 *   central de un MSP, con otra clave, no la toca.
 */
import { createPublicKey } from 'node:crypto';
import { firmaValida, huellaDe, type Firma } from './confianza.ts';

/* Lo que trae la versión firmada: las claves del panel en las que confiar y las que sustituyen. */
export type ClavesPanel = { claves: string[]; reemplaza?: string[] };

const MAX_CLAVES_PANEL = 8;
const HUELLA = /^[0-9a-f]{16}$/;

/* Una clave pública del panel: Ed25519 o ECDSA P-256 en spki DER base64. */
export function clavePanelValida(b64: unknown): b64 is string {
	if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > 200)
		return false;
	try {
		const k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
		return (
			k.asymmetricKeyType === 'ed25519' ||
			(k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1')
		);
	} catch {
		return false;
	}
}

/* Qué falla en el campo clavesPanel de una versión, o null. */
export function motivoClavesPanel(x: unknown): string | null {
	const c = x as ClavesPanel;
	if (!c || typeof c !== 'object' || !Array.isArray(c.claves)) return 'malformed Central keys';
	if (c.claves.length === 0 || c.claves.length > MAX_CLAVES_PANEL) return 'malformed Central keys';
	if (!c.claves.every(clavePanelValida))
		return 'a Central key is not an Ed25519 or ECDSA P-256 public key';
	if (
		c.reemplaza !== undefined &&
		(!Array.isArray(c.reemplaza) ||
			c.reemplaza.length > 16 ||
			c.reemplaza.some((h) => typeof h !== 'string' || !HUELLA.test(h)))
	)
		return 'malformed replaced Central keys';
	return null;
}

/*
 * La lista nueva de claves del panel de un nodo que confía en `actuales`, si esta versión se
 * la cambia; null si no es para él (otro panel) o no cambia nada.
 */
export function clavesPanelTras(actuales: readonly string[], c: ClavesPanel): string[] | null {
	if (motivoClavesPanel(c)) return null;
	const suyas = new Set([...c.claves.map(huellaDe), ...(c.reemplaza ?? [])]);
	if (!actuales.some((k) => suyas.has(huellaDe(k)))) return null;
	const nuevas = [...new Set(c.claves)];
	const igual = nuevas.length === actuales.length && nuevas.every((k) => actuales.includes(k));
	return igual ? null : nuevas;
}

/* Una clave suelta (lo que fijaban los nodos de antes) o la lista. */
const lista = (claves: string | readonly string[]) =>
	(typeof claves === 'string' ? [claves] : [...claves]).filter(Boolean);

/*
 * Si el texto lo firmó alguna de las claves del panel en las que se confía: `firma` con
 * cualquiera de ellas, o una de `firmas` con la de su huella.
 */
export function firmadoPorPanel(
	claves: string | readonly string[],
	texto: string,
	firma: unknown,
	firmas?: unknown
): boolean {
	const candidatas = lista(claves);
	if (typeof firma === 'string' && candidatas.some((k) => firmaValida(k, texto, firma)))
		return true;
	if (!Array.isArray(firmas)) return false;
	for (const f of firmas.slice(0, 8) as Partial<Firma>[]) {
		if (!f || typeof f.clave !== 'string' || typeof f.firma !== 'string') continue;
		const k = candidatas.find((p) => huellaDe(p) === f.clave);
		if (k && firmaValida(k, texto, f.firma)) return true;
	}
	return false;
}

/* Quien firma en el panel: la clave en fichero (síncrona) o la del HSM (una llamada a Azure). */
export type FirmantePanel = {
	publica: string;
	firmar: (texto: string) => string | Promise<string>;
};

/*
 * `firma` con el principal y `firmas` con los demás. Cada firma se comprueba con su pública
 * antes de salir: si el Key Vault devolviera algo que no cuadra, no sale nada firmado.
 */
export async function firmarComoPanel(
	texto: string,
	principal: FirmantePanel,
	extra: readonly FirmantePanel[] = []
): Promise<{ firma: string; firmas?: Firma[] }> {
	const una = async (f: FirmantePanel) => {
		const firma = await f.firmar(texto);
		if (!firmaValida(f.publica, texto, firma))
			throw new Error(`the signature of Central key ${huellaDe(f.publica)} does not verify`);
		return firma;
	};
	const firma = await una(principal);
	if (!extra.length) return { firma };
	const firmas = await Promise.all(
		extra.map(async (f) => ({ clave: huellaDe(f.publica), firma: await una(f) }))
	);
	return { firma, firmas };
}
