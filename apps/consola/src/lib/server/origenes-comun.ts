/*
 * Qué se copió a Orígenes conocidos (origenes.ts) desde la lista blanca, los
 * silencios y las reglas de triaje por IP. Pieza gratis: la leen también la
 * inteligencia, el triaje automático, Listas y Reglas de triaje, que la
 * edición community trae. Allí nunca se migra nada, así que es null y todo
 * sigue como antes.
 */
import { eq } from 'drizzle-orm';
import { contenidaEn } from '@sugardaddy/canal';
import { db, schema as s } from './db';

export const AJUSTE_MIGRADOS = 'origenes_migrados';
export type Migrados = { listas: number[]; silencios: string[]; triaje: string[] };

/* null: este nodo no usa Orígenes conocidos (community, o aún no ha arrancado la migración). */
export async function migrados(): Promise<Migrados | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_MIGRADOS));
	if (!f) return null;
	const v = (f.valor ?? {}) as Partial<Migrados>;
	return { listas: v.listas ?? [], silencios: v.silencios ?? [], triaje: v.triaje ?? [] };
}

/* El origen conocido (activo) que cubre esa IP, a cualquier hora; para enseñarlo en su perfil. */
export async function origenDe(ip: string) {
	const filas = await db
		.select({
			id: s.origenesConocidos.id,
			nombre: s.origenesConocidos.nombre,
			patron: s.origenesConocidos.patron,
			horario: s.origenesConocidos.horario
		})
		.from(s.origenesConocidos)
		.where(eq(s.origenesConocidos.activo, true));
	const o = filas.find((x) => contenidaEn(ip, [x.patron]));
	return o ? { id: o.id, nombre: o.nombre, patron: o.patron, conHorario: !!o.horario } : null;
}
