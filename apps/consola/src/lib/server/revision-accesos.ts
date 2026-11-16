/*
 * Revisión de accesos de la consola (plan de fortificación §4.6, ver
 * lib/revision-accesos.ts para las reglas):
 *
 * - cada entrada (auth/sesion.ts → abrir) apunta la cuenta y su última entrada;
 *   una cuenta desactivada no abre sesión;
 * - cada hora, la que pasa de N días sin entrar se desactiva sola (no se borra) y
 *   sus sesiones se cierran, salvo el último administrador activo;
 * - un administrador confirma la lista cada trimestre (quién y cuándo, con la
 *   lista que vio); si se pasa, la consola lo avisa arriba.
 *
 * Todo queda en la auditoría (auditoria.revision-accesos y auditoria.usuario).
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema as s } from './db';
import { auditar } from './consultas';
import {
	DIAS_INACTIVIDAD_POR_DEFECTO,
	aDesactivar,
	esUltimoAdmin,
	proximaRevision,
	revisionVencida,
	type CuentaAcceso
} from '$lib/revision-accesos';
import type { Identidad } from './auth/entra';

const CLAVE = 'revision-accesos';
type Ajuste = { dias: number };

export async function diasInactividad(): Promise<number> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	const d = Number((f?.valor as Ajuste | undefined)?.dias);
	return Number.isInteger(d) && d > 0 ? d : DIAS_INACTIVIDAD_POR_DEFECTO;
}

export async function fijarDiasInactividad(quien: string, dias: number) {
	const antes = await diasInactividad();
	if (antes === dias) return false;
	const valor: Ajuste = { dias };
	await db
		.insert(s.ajustes)
		.values({ clave: CLAVE, valor })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
	await auditar(quien, 'inactivity period changed', { antes, dias });
	return true;
}

/* Lo que no se apunta: el soporte entra por petición y la emergencia es otra cosa. */
const seApunta = (i: Pick<Identidad, 'oid' | 'soporte'>) =>
	!i.soporte && !i.oid.startsWith('emergencia:');

/*
 * Al abrir sesión: apunta la entrada. Devuelve false si la cuenta está
 * desactivada (y entonces no se apunta nada más que el rechazo).
 */
export async function apuntarEntrada(i: Identidad, ahora = new Date()): Promise<boolean> {
	if (!seApunta(i)) return true;
	const [f] = await db
		.select({ desactivada: s.usuariosAcceso.desactivada })
		.from(s.usuariosAcceso)
		.where(eq(s.usuariosAcceso.oid, i.oid));
	if (f?.desactivada) {
		await auditar(i.correo, 'sign-in denied', { motivo: 'cuenta desactivada' });
		return false;
	}
	await db
		.insert(s.usuariosAcceso)
		.values({
			oid: i.oid,
			correo: i.correo,
			nombre: i.nombre,
			roles: i.roles,
			visto: ahora,
			ultimaEntrada: ahora
		})
		.onConflictDoUpdate({
			target: s.usuariosAcceso.oid,
			set: { correo: i.correo, nombre: i.nombre, roles: i.roles, ultimaEntrada: ahora }
		});
	return true;
}

/* Un usuario local nuevo o con roles nuevos: la lista lo enseña sin esperar a que entre. */
export async function apuntarLocal(u: {
	id: string;
	correo: string;
	nombre: string;
	roles: string[];
}) {
	await db
		.insert(s.usuariosAcceso)
		.values({ oid: `local:${u.id}`, correo: u.correo, nombre: u.nombre, roles: u.roles })
		.onConflictDoUpdate({
			target: s.usuariosAcceso.oid,
			set: { correo: u.correo, nombre: u.nombre, roles: u.roles }
		});
}

export async function rolesLocal(id: string, roles: string[]) {
	await db
		.update(s.usuariosAcceso)
		.set({ roles })
		.where(eq(s.usuariosAcceso.oid, `local:${id}`));
}

/* Un usuario local borrado deja de tener acceso: fuera de la lista. */
export async function olvidarLocal(id: string) {
	await db.delete(s.usuariosAcceso).where(eq(s.usuariosAcceso.oid, `local:${id}`));
}

export async function cuentas() {
	return db.select().from(s.usuariosAcceso).orderBy(asc(s.usuariosAcceso.correo));
}

const comoCuenta = (f: typeof s.usuariosAcceso.$inferSelect): CuentaAcceso => ({
	oid: f.oid,
	roles: f.roles,
	visto: f.visto,
	ultimaEntrada: f.ultimaEntrada,
	reactivada: f.reactivada,
	desactivada: f.desactivada
});

async function cerrarSesiones(oid: string) {
	await db
		.update(s.sesiones)
		.set({ cerrada: new Date() })
		.where(and(eq(s.sesiones.oid, oid), isNull(s.sesiones.cerrada)));
}

/* Cada hora: las cuentas que pasan del plazo, desactivadas. Devuelve cuántas. */
export async function desactivarInactivas(ahora = Date.now()) {
	const dias = await diasInactividad();
	const filas = await cuentas();
	const fuera = aDesactivar(filas.map(comoCuenta), dias, ahora);
	for (const oid of fuera) {
		const [f] = await db
			.update(s.usuariosAcceso)
			.set({ desactivada: new Date(ahora), desactivadaPor: 'node', motivo: 'inactividad' })
			.where(and(eq(s.usuariosAcceso.oid, oid), isNull(s.usuariosAcceso.desactivada)))
			.returning({ correo: s.usuariosAcceso.correo });
		if (!f) continue;
		await cerrarSesiones(oid);
		await auditar('node', 'user disabled for inactivity', { usuario: f.correo, oid, dias });
	}
	return fuera.length;
}

export type ResultadoCuenta = { ok: true } | { ok: false; error: string };

export async function desactivar(quien: string, oid: string): Promise<ResultadoCuenta> {
	const filas = await cuentas();
	const c = filas.find((f) => f.oid === oid);
	if (!c) return { ok: false, error: 'That account is not in the list.' };
	if (c.desactivada) return { ok: false, error: 'That account is already disabled.' };
	if (esUltimoAdmin(filas.map(comoCuenta), oid))
		return { ok: false, error: 'This is the last active administrator: it cannot be disabled.' };
	await db
		.update(s.usuariosAcceso)
		.set({ desactivada: new Date(), desactivadaPor: quien, motivo: 'manual' })
		.where(eq(s.usuariosAcceso.oid, oid));
	await cerrarSesiones(oid);
	await auditar(quien, 'user disabled', { usuario: c.correo, oid });
	return { ok: true };
}

export async function reactivar(quien: string, oid: string): Promise<ResultadoCuenta> {
	const [f] = await db
		.update(s.usuariosAcceso)
		.set({ desactivada: null, desactivadaPor: null, motivo: null, reactivada: new Date() })
		.where(and(eq(s.usuariosAcceso.oid, oid), sql`${s.usuariosAcceso.desactivada} is not null`))
		.returning({ correo: s.usuariosAcceso.correo });
	if (!f) return { ok: false, error: 'That account is not disabled.' };
	await auditar(quien, 'user enabled', { usuario: f.correo, oid });
	return { ok: true };
}

export async function revisiones(limite = 20) {
	return db
		.select()
		.from(s.revisionesAcceso)
		.orderBy(desc(s.revisionesAcceso.cuando))
		.limit(limite);
}

/* El administrador confirma la lista tal como la ve ahora. */
export async function confirmarRevision(quien: string, nota: string | null) {
	const filas = await cuentas();
	const usuarios = filas.map((f) => ({
		oid: f.oid,
		correo: f.correo,
		roles: f.roles,
		ultimaEntrada: f.ultimaEntrada?.toISOString() ?? null,
		activa: !f.desactivada
	}));
	const limpia = nota?.trim().slice(0, 500) || null;
	await db.insert(s.revisionesAcceso).values({ quien, usuarios, nota: limpia });
	await auditar(quien, 'access review confirmed', {
		cuentas: usuarios.length,
		activas: usuarios.filter((u) => u.activa).length,
		nota: limpia
	});
}

/* Para el aviso de arriba y la página: cuándo fue la última y cuándo toca la siguiente. */
export async function estadoRevision(ahora = Date.now()) {
	const [ultima] = await revisiones(1);
	const [{ primera }] = await db
		.select({ primera: sql<Date | null>`min(${s.usuariosAcceso.visto})` })
		.from(s.usuariosAcceso);
	const primeraCuenta = primera ? new Date(primera) : null;
	const proxima = proximaRevision(ultima?.cuando ?? null, primeraCuenta);
	return {
		ultima: ultima ? { cuando: ultima.cuando.toISOString(), quien: ultima.quien } : null,
		proxima: proxima?.toISOString() ?? null,
		vencida: revisionVencida(ultima?.cuando ?? null, primeraCuenta, ahora)
	};
}
