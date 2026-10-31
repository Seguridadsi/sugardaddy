/*
 * Triaje automático (gratis): marcar solos, al recibirlos, los eventos nuevos
 * que casan una regla, para que el operador no tenga que triajar a mano lo
 * repetitivo (un escáner conocido como falso positivo, una IP propia como
 * revisada, un usuario de pruebas…). Las reglas las gestiona /eventos/reglas;
 * se aplican SOLO a los eventos nuevos, nunca al histórico (forward-only).
 *
 * El cotejo es puro y testeable (casaReglaTriaje/triajeDeReglas).
 * aplicarTriajeAuto lo engancha recibirEventos TRAS el commit, sin esperarle y
 * sin poder tumbar la entrega (fail-open total: ante cualquier fallo no triaja
 * nada y la recepción sigue). El triaje puesto a mano por una persona manda: el
 * INSERT es onConflictDoNothing, así que nunca pisa un triaje que ya existe.
 *
 * Pieza gratis: vive fuera de salidas/ y respuesta/, así la edición community
 * la trae igual (el triaje es gratis). No importa nada de pago.
 */
import { asc, eq } from 'drizzle-orm';
import { contenidaEn } from '@sugardaddy/canal';
import type { Evento } from '@sugardaddy/contrato';
import { db, schema as s } from './db';

export type ReglaTriaje = typeof s.reglasTriaje.$inferSelect;
export const CRITERIOS_TRIAJE = ['ip', 'usuario', 'comando', 'trampa'] as const;
export type CriterioTriaje = (typeof CRITERIOS_TRIAJE)[number];

/*
 * Lo que el atacante tecleó o envió, para el criterio «comando»: solo los
 * VALORES de texto del detalle (lo que escribió el atacante) más la línea cruda,
 * en minúsculas. NO las claves del detalle: sus nombres (input, ruta, usuario…)
 * los fija el manifiesto de la trampa, no el atacante, y meterlos haría que una
 * regla «comando: input» casara TODOS los eventos SSH por la clave y auto-triara
 * ataques reales, sacándolos de la cola de «sin triar».
 */
function textoEvento(e: Evento): string {
	const partes = Object.values(e.detalle ?? {}).filter((v): v is string => typeof v === 'string');
	if (typeof e.crudo === 'string') partes.push(e.crudo);
	return partes.join(' ').toLowerCase();
}

/*
 * ¿El evento casa esta regla? Puro, sin base de datos. `comandoTexto` permite
 * pasar el texto de cotejo ya calculado (triajeDeReglas lo calcula una sola vez
 * por evento, no una por regla); por defecto se calcula aquí para usarlo suelto.
 */
export function casaReglaTriaje(
	regla: ReglaTriaje,
	e: Evento,
	comandoTexto: () => string = () => textoEvento(e)
): boolean {
	const valor = regla.valor.trim();
	if (!valor) return false;
	switch (regla.criterio as CriterioTriaje) {
		case 'ip':
			/* contenidaEn cubre IP exacta y CIDR (v4/v6); un patrón corrupto no lanza. */
			return !!e.origen.ip && contenidaEn(e.origen.ip, [valor]);
		case 'usuario':
			return !!e.origen.usuario && e.origen.usuario.toLowerCase() === valor.toLowerCase();
		case 'comando':
			return comandoTexto().includes(valor.toLowerCase());
		case 'trampa':
			return e.trampa.id === valor;
		default:
			return false;
	}
}

/*
 * El triaje que le toca a un evento según las reglas: la PRIMERA regla activa
 * que casa (por orden de creación), o null si ninguna. Las reglas ya vienen
 * filtradas por activa y ordenadas. El texto de cotejo del criterio «comando» se
 * calcula como mucho una vez por evento (perezoso), no una por regla.
 */
export function triajeDeReglas(
	reglas: readonly ReglaTriaje[],
	e: Evento
): { estado: ReglaTriaje['estado']; nota: string | null } | null {
	let texto: string | null = null;
	const comandoTexto = () => (texto ??= textoEvento(e));
	for (const r of reglas) {
		if (casaReglaTriaje(r, e, comandoTexto)) return { estado: r.estado, nota: r.nota };
	}
	return null;
}

/*
 * Aplica las reglas a una tanda de eventos nuevos y deja su triaje. No se
 * espera (como el motor y las salidas): la respuesta al sensor no depende de
 * esto. Todo bajo try/catch: un fallo aquí nunca frena la recepción.
 */
export function aplicarTriajeAuto(eventos: readonly Evento[]): void {
	if (!eventos.length) return;
	Promise.resolve(aplicarTriajeAutoAhora(eventos)).catch((err) =>
		console.error('[triaje-auto] no se pudo aplicar el triaje automático', err)
	);
}

/* El trabajo de verdad, esperable (para las pruebas). aplicarTriajeAuto lo lanza sin esperar. */
export async function aplicarTriajeAutoAhora(eventos: readonly Evento[]): Promise<void> {
	const reglas = await db
		.select()
		.from(s.reglasTriaje)
		.where(eq(s.reglasTriaje.activa, true))
		.orderBy(asc(s.reglasTriaje.creado));
	if (!reglas.length) return;
	const filas = [];
	for (const e of eventos) {
		const t = triajeDeReglas(reglas, e);
		if (t)
			filas.push({ evento: e.id, estado: t.estado, nota: t.nota, quien: 'triaje automático' });
	}
	if (!filas.length) return;
	/* No pisa un triaje ya puesto (a mano o por una regla anterior): el de la persona manda. */
	await db.insert(s.triaje).values(filas).onConflictDoNothing({ target: s.triaje.evento });
}
