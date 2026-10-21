/*
 * Acceso de soporte de SeguridadSI, decidido por el cliente.
 *
 * La petición llega firmada dentro del estado deseado. El administrador del
 * cliente la acepta (con un rol y una duración) o la rechaza. Mientras está
 * abierta, el personal del grupo de soporte de SeguridadSI puede entrar con
 * ese rol; al caducar o al cerrarla el cliente, sus sesiones se cierran.
 */
import { and, eq } from 'drizzle-orm';
import type { SolicitudSoporte } from '@sugardaddy/canal';
import { db, schema as s } from './db';
import { auditar } from './consultas';

export type RolSoporte = 'lector' | 'operador';

export type Soporte = {
	estado: 'cerrado' | 'solicitado' | 'abierto' | 'rechazado';
	solicitud: SolicitudSoporte | null;
	hasta: string | null;
	rol: RolSoporte | null;
};

const CERRADO: Soporte = { estado: 'cerrado', solicitud: null, hasta: null, rol: null };

async function leer(): Promise<Soporte> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'soporte'));
	return (f?.valor as Soporte) ?? CERRADO;
}

async function guardar(v: Soporte) {
	await db
		.insert(s.ajustes)
		.values({ clave: 'soporte', valor: v })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: v } });
}

async function cerrarSesionesDeSoporte() {
	await db
		.update(s.sesiones)
		.set({ cerrada: new Date() })
		.where(and(eq(s.sesiones.soporte, true)));
}

/* El estado actual, cerrando solo lo que ya ha caducado. */
export async function soporte(): Promise<Soporte> {
	const v = await leer();
	if (v.estado === 'abierto' && v.hasta && Date.parse(v.hasta) <= Date.now()) {
		const cerrado = { ...v, estado: 'cerrado' as const, hasta: null, rol: null };
		await guardar(cerrado);
		await cerrarSesionesDeSoporte();
		await auditar('nodo', 'acceso de soporte caducado');
		return cerrado;
	}
	return v;
}

export const abierto = async () => (await soporte()).estado === 'abierto';

/* Llamado tras cada latido con lo que trae el estado deseado (ya verificado). */
export async function recibirSolicitud(sol: SolicitudSoporte | null) {
	if (!sol) return;
	const v = await soporte();
	if (v.solicitud?.cuando === sol.cuando || v.estado === 'abierto') return;
	await guardar({ estado: 'solicitado', solicitud: sol, hasta: null, rol: null });
	await auditar('panel central', 'SeguridadSI pide acceso de soporte', {
		por: sol.por,
		motivo: sol.motivo
	});
}

export async function aceptar(quien: string, horas: number, rol: RolSoporte) {
	const v = await soporte();
	if (v.estado !== 'solicitado') return false;
	const hasta = new Date(Date.now() + horas * 3600_000).toISOString();
	await guardar({ ...v, estado: 'abierto', hasta, rol });
	await auditar(quien, 'acceso de soporte abierto', { hasta, rol, motivo: v.solicitud?.motivo });
	return true;
}

export async function rechazar(quien: string) {
	const v = await soporte();
	if (v.estado !== 'solicitado') return false;
	await guardar({ ...v, estado: 'rechazado', hasta: null, rol: null });
	await auditar(quien, 'acceso de soporte rechazado', { motivo: v.solicitud?.motivo });
	return true;
}

export async function cerrarYa(quien: string) {
	const v = await soporte();
	if (v.estado !== 'abierto') return false;
	await guardar({ ...v, estado: 'cerrado', hasta: null, rol: null });
	await cerrarSesionesDeSoporte();
	await auditar(quien, 'acceso de soporte cerrado por el cliente');
	return true;
}

/* Lo que sube en el latido: estado, a qué petición responde y hasta cuándo. */
export async function paraLatido() {
	const v = await soporte();
	return { estado: v.estado, solicitud: v.solicitud?.cuando ?? null, hasta: v.hasta };
}
