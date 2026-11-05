/*
 * Quién lleva este nodo, para los textos que lee el cliente: SeguridadSI o, si
 * lo gestiona un MSP, el nombre que manda su panel en el estado firmado
 * (docs/diseno/msp.md). Sin panel, SeguridadSI.
 */
import { eq } from 'drizzle-orm';
import { db, schema as s } from './db';

export const OPERADOR_POR_DEFECTO = 'SeguridadSI';

export function operadorDe(canal: unknown) {
	const nombre = (canal as { estado?: { operador?: unknown } } | null | undefined)?.estado
		?.operador;
	return typeof nombre === 'string' && nombre.trim()
		? nombre.trim().slice(0, 60)
		: OPERADOR_POR_DEFECTO;
}

export async function operador() {
	const [f] = await db
		.select({ valor: s.ajustes.valor })
		.from(s.ajustes)
		.where(eq(s.ajustes.clave, 'canal'));
	return operadorDe(f?.valor);
}
