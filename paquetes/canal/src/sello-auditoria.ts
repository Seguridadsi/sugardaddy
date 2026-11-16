/*
 * El sello de la auditoría de la consola visto desde fuera del nodo
 * (docs/diseno/auditoria-inmutable.md): el panel lo comprueba al recibirlo en el
 * latido y herramientas/verificar-sellos-auditoria.ts lo vuelve a comprobar
 * contra una exportación.
 *
 * El gemelo que firma está en apps/consola/scripts/auditoria.mjs (firmarSello,
 * textoSello): el texto tiene que ser el mismo byte a byte. Una prueba de la
 * consola firma con aquel y verifica con este.
 *
 * Solo Ed25519: el sello HMAC de un nodo sin panel (Community) no lo puede
 * comprobar nadie más que el propio nodo, y ese nodo no late al panel.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

export type SelloAuditoria = {
	nodo: string;
	hasta: number;
	hash: string;
	cuando: string;
	algoritmo: 'ed25519' | 'hmac-sha256';
	firma: string;
};

export const textoSelloAuditoria = (
	s: Pick<SelloAuditoria, 'nodo' | 'hasta' | 'hash' | 'cuando'>
) => `sugardaddy/auditoria-sello\n${s.nodo}\n${s.hasta}\n${s.hash}\n${s.cuando}`;

/* La misma huella que guarda la consola en auditoria_sellos.clave. */
export const huellaSello = (publicaB64: string) =>
	createHash('sha256').update(Buffer.from(publicaB64, 'base64')).digest('hex').slice(0, 16);

/*
 * ¿Es buena la firma? null si no se puede saber desde fuera (un sello HMAC);
 * false si la firma no casa o la clave no se puede leer.
 */
export function verificarSelloAuditoria(s: SelloAuditoria, publicaB64: string): boolean | null {
	if (s.algoritmo !== 'ed25519') return null;
	try {
		const k = createPublicKey({
			key: Buffer.from(publicaB64, 'base64'),
			format: 'der',
			type: 'spki'
		});
		return verify(
			null,
			Buffer.from(textoSelloAuditoria(s), 'utf8'),
			k,
			Buffer.from(s.firma, 'base64')
		);
	} catch {
		return false;
	}
}

/* Lo que el panel acepta del latido; null si algo no casa (se ignora el sello, no el latido). */
export function leerSelloLatido(v: unknown): Omit<SelloAuditoria, 'nodo'> | null {
	const a = v as Record<string, unknown> | null;
	if (!a || typeof a !== 'object') return null;
	const ok =
		Number.isSafeInteger(a.hasta) &&
		(a.hasta as number) > 0 &&
		typeof a.hash === 'string' &&
		/^[0-9a-f]{64}$/.test(a.hash) &&
		typeof a.cuando === 'string' &&
		a.cuando.length <= 40 &&
		Number.isFinite(Date.parse(a.cuando)) &&
		(a.algoritmo === 'ed25519' || a.algoritmo === 'hmac-sha256') &&
		typeof a.firma === 'string' &&
		a.firma.length <= 200 &&
		/^[A-Za-z0-9+/]+={0,2}$/.test(a.firma);
	return ok
		? {
				hasta: a.hasta as number,
				hash: a.hash as string,
				cuando: a.cuando as string,
				algoritmo: a.algoritmo as SelloAuditoria['algoritmo'],
				firma: a.firma as string
			}
		: null;
}
