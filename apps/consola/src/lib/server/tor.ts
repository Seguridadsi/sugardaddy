/*
 * Nodos de salida de Tor en el nodo. Llegan del panel, firmados, una vez al
 * día; se guardan aparte de las listas negras del cliente. Marcan los eventos
 * que llegan por Tor, y van a los firewalls (EDL) solo si el cliente lo activa.
 */
import { eq } from 'drizzle-orm';
import type { ListaTor } from '@sugardaddy/canal';
import { db, schema as s } from './db';

type Guardada = { huella: string; lista: ListaTor };
type Uso = { edl: boolean };

async function ajuste<T>(clave: string): Promise<T | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return (f?.valor as T | undefined) ?? null;
}

async function poner(clave: string, valor: unknown) {
	await db
		.insert(s.ajustes)
		.values({ clave, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
}

export const huellaTor = async () => (await ajuste<Guardada>('tor'))?.huella ?? null;

export async function guardarTor(huella: string, lista: ListaTor) {
	await poner('tor', { huella, lista });
	conjunto = null;
}

export async function quitarTor() {
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'tor'));
	conjunto = null;
}

/* La lista vigente; caducada no se usa (el panel ha dejado de renovarla). */
export async function listaTor() {
	const g = await ajuste<Guardada>('tor');
	if (!g || Date.parse(g.lista.caduca) < Date.now()) return null;
	return g.lista;
}

let conjunto: { hasta: number; ips: Set<string> } | null = null;

/* Para marcar eventos: se relee como mucho cada minuto. */
export async function ipsTor() {
	if (conjunto && conjunto.hasta > Date.now()) return conjunto.ips;
	const l = await listaTor();
	conjunto = { hasta: Date.now() + 60_000, ips: new Set(l?.ips ?? []) };
	return conjunto.ips;
}

export const usoTor = async () => (await ajuste<Uso>('tor-uso')) ?? { edl: false };

export async function cambiarUsoTor(quien: string, uso: Uso) {
	await poner('tor-uso', uso);
	await db.insert(s.auditoria).values({
		quien,
		accion: uso.edl ? 'lista de Tor a los firewalls' : 'lista de Tor fuera de los firewalls',
		detalle: uso
	});
}
