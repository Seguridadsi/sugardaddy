/*
 * La zona horaria de lo que sale de la consola para más de una persona: el
 * informe, el resumen semanal y el aviso de pentest (lib/fechas.ts). Es del
 * nodo, no de un usuario: un cliente de otro país la cambia en Ajustes. Sin
 * elegir, la de serie. Las salidas de avisos tienen cada una la suya.
 */
import { eq } from 'drizzle-orm';
import { ZONA_POR_DEFECTO, zonaValida } from '$lib/fechas';
import { db, schema as s } from './db';

const AJUSTE = 'zona-documentos';

export async function zonaDocumentos(): Promise<string> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE));
	const zona = (f?.valor as { zona?: unknown } | undefined)?.zona;
	return typeof zona === 'string' && zonaValida(zona) ? zona : ZONA_POR_DEFECTO;
}

/* false si no es una zona que este servidor conozca. */
export async function fijarZonaDocumentos(quien: string, zona: string): Promise<boolean> {
	if (!zonaValida(zona)) return false;
	await db.transaction(async (tx) => {
		await tx
			.insert(s.ajustes)
			.values({ clave: AJUSTE, valor: { zona } })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: { zona } } });
		await tx
			.insert(s.auditoria)
			.values({ quien, accion: 'document time zone changed', detalle: { zona } });
	});
	return true;
}
