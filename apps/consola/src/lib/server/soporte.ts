/*
 * Acceso de soporte de SeguridadSI, decidido por el cliente.
 *
 * La petición llega firmada dentro del estado deseado. El administrador del
 * cliente la acepta (con un rol y un plazo) o la rechaza. Mientras está
 * abierta, la persona de SeguridadSI que la pidió puede entrar con ese rol; al
 * caducar o al cerrarla el cliente, sus sesiones se cierran.
 *
 * El plazo tiene un máximo (30 días) y se renueva desde Ajustes: ya no hay
 * «hasta que lo cierre» (docs/diseno/identidad-clientes.md §3). Un soporte
 * abierto sin plazo de antes de este cambio pasa a 30 días la primera vez que
 * se lee.
 */
import { eq } from 'drizzle-orm';
import type { SolicitudSoporte } from '@sugardaddy/canal';
import { db, schema as s } from './db';
import { auditar } from './consultas';
import { operador } from './operador';

export type RolSoporte = 'lector' | 'operador';

export type Soporte = {
	estado: 'cerrado' | 'solicitado' | 'abierto' | 'rechazado';
	solicitud: SolicitudSoporte | null;
	hasta: string | null;
	rol: RolSoporte | null;
};

const DIA = 24 * 3600_000;
/* Lo más que dura un acceso de soporte sin que el cliente lo renueve. */
export const MAXIMO_HORAS = 30 * 24;
/* Cuánto antes de caducar lo avisa la consola. */
export const AVISO_MS = 3 * DIA;
/* Los plazos que se ofrecen al aceptar o renovar, en horas. El primero es el de por defecto. */
export const PLAZOS = [MAXIMO_HORAS, 7 * 24, 8] as const;

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
	await db.update(s.sesiones).set({ cerrada: new Date() }).where(eq(s.sesiones.soporte, true));
}

/* Un plazo pedido, recortado a lo permitido. Lo que no es un número da el de por defecto. */
export function horasValidas(h: unknown): number {
	const n = typeof h === 'number' ? h : Number(h);
	if (!Number.isFinite(n) || n <= 0) return PLAZOS[0];
	return Math.min(Math.round(n), MAXIMO_HORAS);
}

const plazo = (horas: number, ahora = Date.now()) =>
	new Date(ahora + horasValidas(horas) * 3600_000).toISOString();

/* El estado actual, cerrando lo que ya ha caducado y poniendo plazo a lo que no lo tenía. */
export async function soporte(): Promise<Soporte> {
	const v = await leer();
	if (v.estado !== 'abierto') return v;
	if (!v.hasta) {
		const conPlazo = { ...v, hasta: plazo(MAXIMO_HORAS) };
		await guardar(conPlazo);
		await auditar('node', 'support access without a time limit now expires in 30 days', {
			hasta: conPlazo.hasta
		});
		return conPlazo;
	}
	if (Date.parse(v.hasta) <= Date.now()) {
		const cerrado = { ...v, estado: 'cerrado' as const, hasta: null, rol: null };
		await guardar(cerrado);
		await cerrarSesionesDeSoporte();
		await auditar('node', 'support access expired');
		return cerrado;
	}
	return v;
}

export const abierto = async () => (await soporte()).estado === 'abierto';

/* Abierto y a punto de caducar: lo que la consola avisa a los administradores. */
export const porCaducar = (v: Soporte, ahora = Date.now()) =>
	v.estado === 'abierto' && !!v.hasta && Date.parse(v.hasta) - ahora < AVISO_MS;

/* Llamado tras cada latido con lo que trae el estado deseado (ya verificado). */
export async function recibirSolicitud(sol: SolicitudSoporte | null) {
	if (!sol) return;
	const v = await soporte();
	if (v.solicitud?.cuando === sol.cuando || v.estado === 'abierto') return;
	await guardar({ estado: 'solicitado', solicitud: sol, hasta: null, rol: null });
	await auditar('Central', `${await operador()} requests support access`, {
		por: sol.por,
		motivo: sol.motivo
	});
}

export async function aceptar(quien: string, horas: number, rol: RolSoporte = 'lector') {
	const v = await soporte();
	if (v.estado !== 'solicitado') return false;
	const hasta = plazo(horas);
	await guardar({ ...v, estado: 'abierto', hasta, rol });
	await auditar(quien, 'support access opened', { hasta, rol, motivo: v.solicitud?.motivo });
	return true;
}

/* Otro plazo desde ahora, con el mismo rol. */
export async function renovar(quien: string, horas: number) {
	const v = await soporte();
	if (v.estado !== 'abierto') return null;
	const hasta = plazo(horas);
	await guardar({ ...v, hasta });
	await auditar(quien, 'support access renewed', { hasta, rol: v.rol });
	return hasta;
}

export async function rechazar(quien: string) {
	const v = await soporte();
	if (v.estado !== 'solicitado') return false;
	await guardar({ ...v, estado: 'rechazado', hasta: null, rol: null });
	await auditar(quien, 'support access rejected', { motivo: v.solicitud?.motivo });
	return true;
}

export async function cerrarYa(quien: string) {
	const v = await soporte();
	if (v.estado !== 'abierto') return false;
	await guardar({ ...v, estado: 'cerrado', hasta: null, rol: null });
	await cerrarSesionesDeSoporte();
	await auditar(quien, 'support access closed by the customer');
	return true;
}

/* Lo que sube en el latido: estado, a qué petición responde y hasta cuándo. */
export async function paraLatido() {
	const v = await soporte();
	return { estado: v.estado, solicitud: v.solicitud?.cuando ?? null, hasta: v.hasta };
}
