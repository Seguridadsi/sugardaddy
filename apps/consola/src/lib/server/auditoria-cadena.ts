/*
 * La auditoría inmutable, del lado de la consola (docs/diseno/auditoria-inmutable.md).
 * La cadena de hash la pone la base (migración 0058); aquí:
 *
 *   - sellar: cada hora, si la cabeza ha cambiado, su hash firmado con la clave
 *     del nodo queda en auditoria_sellos. De ahí sale al SIEM del cliente
 *     (auditoria.sello, salidas/auditoria.ts) y en el latido al panel.
 *   - verificar: la cadena entera y sus sellos (lo mismo que el comando de la
 *     máquina, scripts/verificar-auditoria.mjs).
 *
 * La clave del nodo: la Ed25519 de su canal con el panel; un nodo sin panel
 * (Community) firma con un HMAC derivado de CLAVE_SECRETOS. Ninguna sale de la
 * máquina.
 */
import { desc, eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, schema as s } from './db';
import { firmarSello, verificarAuditoria, type ClaveSello } from '../../../scripts/auditoria.mjs';

type CanalGuardado = { nodo?: string; clavePrivada?: string; clavePublica?: string };

async function ajuste<T>(clave: string): Promise<T | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return (f?.valor as T) ?? null;
}

/* El id del nodo (el mismo que ve el panel) y su clave para firmar, si la tiene. */
export async function identidadSello(): Promise<{
	nodo: string;
	clave: ClaveSello | null;
	publica: string | null;
	secreto: string | null;
}> {
	const canal = await ajuste<CanalGuardado>('canal');
	const nodo = canal?.nodo ?? (await ajuste<{ nodo?: string }>('nodo'))?.nodo ?? 'nodo';
	const secreto = /^[0-9a-fA-F]{64}$/.test(env.CLAVE_SECRETOS?.trim() ?? '')
		? env.CLAVE_SECRETOS!.trim()
		: null;
	const clave: ClaveSello | null =
		canal?.clavePrivada && canal.clavePublica
			? { algoritmo: 'ed25519', privada: canal.clavePrivada, publica: canal.clavePublica }
			: secreto
				? { algoritmo: 'hmac-sha256', secreto }
				: null;
	return { nodo, clave, publica: canal?.clavePublica ?? null, secreto };
}

export type Sello = typeof s.auditoriaSellos.$inferSelect;

/*
 * Sella la cabeza si ha cambiado desde el último sello. Sin clave con la que
 * firmar (ni canal ni CLAVE_SECRETOS) no sella: lo dice el registro.
 */
export async function sellar(ahora = new Date()): Promise<Sello | null> {
	const [cabeza] = await db
		.select({ id: s.auditoria.id, hash: s.auditoria.hash })
		.from(s.auditoria)
		.orderBy(desc(s.auditoria.id))
		.limit(1);
	if (!cabeza) return null;
	const ultimo = await ultimoSello();
	if (ultimo && ultimo.hasta === cabeza.id && ultimo.hash === cabeza.hash) return null;
	const { nodo, clave } = await identidadSello();
	if (!clave) {
		console.warn(
			'[auditoria] no key to seal the audit log (no Central channel nor CLAVE_SECRETOS)'
		);
		return null;
	}
	/* Milisegundos, como los guarda Postgres sin perder nada al volver a leerlo. */
	const cuando = new Date(Math.floor(ahora.getTime()));
	const firma = firmarSello(clave, {
		nodo,
		hasta: cabeza.id,
		hash: cabeza.hash,
		cuando: cuando.toISOString()
	});
	const [sello] = await db
		.insert(s.auditoriaSellos)
		.values({ cuando, hasta: cabeza.id, hash: cabeza.hash, ...firma })
		.returning();
	return sello;
}

export async function ultimoSello(): Promise<Sello | null> {
	const [f] = await db
		.select()
		.from(s.auditoriaSellos)
		.orderBy(desc(s.auditoriaSellos.id))
		.limit(1);
	return f ?? null;
}

/* Lo que va en el latido al panel: el último sello, para que lo guarde fuera del nodo. */
export async function selloParaLatido() {
	const f = await ultimoSello();
	return f
		? {
				auditoria: {
					hasta: f.hasta,
					hash: f.hash,
					cuando: f.cuando.toISOString(),
					algoritmo: f.algoritmo,
					firma: f.firma
				}
			}
		: {};
}

/* La cadena entera (o desde un id) y sus sellos. */
export async function verificar(desde?: number) {
	const { nodo, publica, secreto } = await identidadSello();
	return verificarAuditoria(db.$client, { desde, nodo, publica, secreto });
}
