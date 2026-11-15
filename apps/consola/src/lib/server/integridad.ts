/*
 * Lo que el actualizador ve de la máquina del nodo frente a su versión firmada
 * (sensor/internal/actualizador/integridad.go): cada pocos minutos manda lo que
 * no casa (el compose, el .env, versiones.env, las imágenes en marcha). Aquí se
 * guarda lo último y, cuando cambia, se apunta en la auditoría: al empezar una
 * desviación (o cambiar cuáles hay) y al acabar. De la auditoría sale al SIEM
 * del cliente como integridad.desviacion, crítico (salidas/auditoria.ts).
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema as s } from './db';

/* Las acciones de la auditoría: su clase en el SIEM depende de este texto exacto. */
export const ACCION_DESVIACION = 'node integrity deviation';
export const ACCION_DESVIACION_RESUELTA = 'node integrity restored';

const CLAVE = 'integridad';
const TIPOS = ['firma', 'fichero', 'versiones', 'env', 'imagen'] as const;
const MAX = 50;

export type Desviacion = { tipo: (typeof TIPOS)[number]; detalle: string };
export type EstadoIntegridad = {
	version: string;
	desviaciones: Desviacion[];
	huella: string;
	comprobado: string;
};

/* Lo que manda el actualizador, validado; null si no tiene forma. */
export function leerInforme(b: unknown): { version: string; desviaciones: Desviacion[] } | null {
	if (!b || typeof b !== 'object') return null;
	const { version, desviaciones } = b as Record<string, unknown>;
	if (typeof version !== 'string' || version.length > 40 || !Array.isArray(desviaciones))
		return null;
	const ds: Desviacion[] = [];
	for (const d of desviaciones.slice(0, MAX)) {
		if (!d || typeof d !== 'object') return null;
		const { tipo, detalle } = d as Record<string, unknown>;
		if (!TIPOS.includes(tipo as Desviacion['tipo']) || typeof detalle !== 'string') return null;
		ds.push({ tipo: tipo as Desviacion['tipo'], detalle: detalle.slice(0, 500) });
	}
	return { version, desviaciones: ds };
}

const huellaDe = (ds: Desviacion[]) =>
	createHash('sha256')
		.update(JSON.stringify([...ds].map((d) => `${d.tipo}:${d.detalle}`).sort()))
		.digest('hex');

export async function estadoIntegridad(): Promise<EstadoIntegridad | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	return (f?.valor as EstadoIntegridad) ?? null;
}

/* Guarda lo que ha visto el actualizador y lo apunta en la auditoría si ha cambiado. */
export async function recibirIntegridad(informe: {
	version: string;
	desviaciones: Desviacion[];
}): Promise<'nueva' | 'resuelta' | 'igual'> {
	return db.transaction(async (tx) => {
		const [f] = await tx.select().from(s.ajustes).where(eq(s.ajustes.clave, CLAVE)).for('update');
		const antes = (f?.valor as EstadoIntegridad | undefined) ?? null;
		const huella = huellaDe(informe.desviaciones);
		const valor: EstadoIntegridad = { ...informe, huella, comprobado: new Date().toISOString() };
		await tx
			.insert(s.ajustes)
			.values({ clave: CLAVE, valor })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor } });
		const habia = !!antes?.desviaciones.length;
		if (informe.desviaciones.length && (!habia || antes!.huella !== huella)) {
			await tx.insert(s.auditoria).values({
				quien: 'machine',
				accion: ACCION_DESVIACION,
				detalle: { version: informe.version, desviaciones: informe.desviaciones }
			});
			return 'nueva';
		}
		if (!informe.desviaciones.length && habia) {
			await tx.insert(s.auditoria).values({
				quien: 'machine',
				accion: ACCION_DESVIACION_RESUELTA,
				detalle: { version: informe.version }
			});
			return 'resuelta';
		}
		return 'igual';
	});
}
