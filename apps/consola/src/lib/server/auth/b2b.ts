/*
 * Salir del modelo B2B (los usuarios del cliente como invitados en el tenant de
 * SeguridadSI, con el ENTRA_* del .env) hacia el Entra propio del cliente, sin
 * quedarse fuera. docs/diseno/identidad-clientes.md §4.
 *
 * El asistente de Ajustes va en tres pasos: conectar el Entra propio (que ya
 * manda en cuanto se activa), dar a su equipo los mismos roles en su aplicación
 * y, al final, RETIRAR el B2B. Retirarlo es lo que cierra la puerta: sin ello,
 * si el secreto propio dejara de leerse, la consola volvería a aceptar el
 * Entra de SeguridadSI. Con el B2B retirado, la consola lo ignora aunque siga en
 * el .env (configActiva, entra-propio.ts).
 */
import { and, desc, eq, gt, isNull, ne, notLike } from 'drizzle-orm';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { configuradoEnEntorno } from './entra';
import { ROLES, type Rol } from './permisos';

const AJUSTE = 'entra_b2b';

type Retirada = { retirado: string; por: string };

export async function retiradaB2B(): Promise<Retirada | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE));
	return (f?.valor as Retirada | undefined) ?? null;
}

/*
 * En qué punto está este nodo:
 * - `no`: nunca tuvo el Entra de SeguridadSI (Community, Cloud nuevo);
 * - `activo`: lo tiene y lo acepta (con o sin Entra propio todavía);
 * - `retirado`: lo tuvo y ya no lo acepta.
 */
export async function estadoB2B(): Promise<'no' | 'activo' | 'retirado'> {
	if (await retiradaB2B()) return 'retirado';
	return configuradoEnEntorno() ? 'activo' : 'no';
}

/*
 * Quién ha entrado por Microsoft en los últimos 90 días, con el último rol que
 * trajo: a quién hay que dar rol en la aplicación propia. Sin las entradas
 * locales, de emergencia ni de soporte.
 */
export async function equipoB2B(ahora = Date.now()) {
	const filas = await db
		.select({ correo: s.sesiones.correo, nombre: s.sesiones.nombre, roles: s.sesiones.roles })
		.from(s.sesiones)
		.where(
			and(
				eq(s.sesiones.soporte, false),
				notLike(s.sesiones.oid, 'local:%'),
				notLike(s.sesiones.oid, 'emergencia%'),
				gt(s.sesiones.creada, new Date(ahora - 90 * 24 * 3600_000))
			)
		)
		.orderBy(desc(s.sesiones.creada))
		.limit(2000);
	const vistos = new Map<string, { correo: string; nombre: string; rol: Rol }>();
	for (const f of filas) {
		if (vistos.has(f.correo)) continue;
		/* El rol más alto que traía: el último de la lista (ROLES va de menos a más). */
		const rol = [...ROLES].reverse().find((r) => f.roles.includes(r));
		if (rol) vistos.set(f.correo, { correo: f.correo, nombre: f.nombre, rol });
	}
	return [...vistos.values()].sort((a, b) => a.correo.localeCompare(b.correo));
}

/*
 * Deja de aceptar el Entra de SeguridadSI. Solo con el Entra propio activo y
 * legible (si no, la consola se quedaría sin entrada con Microsoft). Cierra las
 * demás sesiones: las abiertas por B2B no deben seguir vivas.
 */
export async function retirarB2B(
	quien: string,
	sesionActual: string | null,
	propio: { activo: boolean; legible: boolean } | null
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!propio?.activo || !propio.legible)
		return {
			ok: false,
			error:
				'Connect and test your own Entra ID first: otherwise nobody could sign in with Microsoft.'
		};
	if (await retiradaB2B()) return { ok: true };
	const v: Retirada = { retirado: new Date().toISOString(), por: quien };
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE, valor: v })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: v } });
	const cerradas = await db
		.update(s.sesiones)
		.set({ cerrada: new Date() })
		.where(
			and(isNull(s.sesiones.cerrada), sesionActual ? ne(s.sesiones.id, sesionActual) : undefined)
		)
		.returning({ id: s.sesiones.id });
	await auditar(quien, 'SeguridadSI Entra ID sign-in retired: only your own Entra ID is accepted', {
		sesionesCerradas: cerradas.length
	});
	return { ok: true };
}
