/*
 * Ajustes → Export: la salida del cliente (lib/server/exportacion.ts). Qué lleva la
 * exportación, las anteriores (de la auditoría) y cómo comprobarla. La descarga
 * es archive/+server.ts.
 */
import { exigir } from '$lib/server/auth/permisos';
import { TABLAS_EXPORT, historialExportaciones } from '$lib/server/exportacion';
import { FORMATO_EXPORTACION } from '$lib/server/exportacion-formato';
import { db } from '$lib/server/db';

export const load = async ({ locals }) => {
	const u = exigir(locals, 'ajustes');
	const sql = db.$client;
	/* Un recuento aproximado (del planificador): no recorre la tabla de eventos. */
	const [aprox] = await sql<{ n: number }[]>`
		SELECT greatest(reltuples, 0)::float8 AS n FROM pg_class WHERE relname = 'eventos'`;
	const historial = await historialExportaciones(20);
	return {
		formato: FORMATO_EXPORTACION,
		soporte: !!u.soporte,
		eventosAprox: Math.round(aprox?.n ?? 0),
		secciones: TABLAS_EXPORT.map((t) => ({
			seccion: t.seccion,
			nombre: t.nombre,
			cef: !!t.cef,
			quitadas: t.quitar ?? []
		})),
		historial: historial.map((h) => ({
			id: h.id,
			cuando: h.cuando.toISOString(),
			quien: h.quien,
			ok: h.accion === 'full data export completed',
			archivo: typeof h.detalle.archivoSha256 === 'string' ? h.detalle.archivoSha256 : null,
			manifiesto:
				typeof h.detalle.manifiestoSha256 === 'string' ? h.detalle.manifiestoSha256 : null,
			bytes: typeof h.detalle.bytes === 'number' ? h.detalle.bytes : null,
			eventos:
				h.detalle.filas && typeof (h.detalle.filas as Record<string, unknown>).eventos === 'number'
					? ((h.detalle.filas as Record<string, number>).eventos ?? null)
					: null,
			motivo: typeof h.detalle.motivo === 'string' ? h.detalle.motivo : null
		}))
	};
};
