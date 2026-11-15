/*
 * Solo para las pruebas: la auditoría no se deja borrar (migración 0058), ni
 * siquiera por el dueño de la tabla. Para limpiar lo suyo, una prueba lo hace
 * como lo haría un superusuario: con los triggers apagados en su transacción
 * (session_replication_role = replica). Las pruebas corren con el usuario que
 * crea la base, que lo es; la consola de un nodo nunca llama a esto.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auditoria } from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bd = PgDatabase<PgQueryResultHKT, any, any>;

export async function borrarAuditoriaDePrueba(db: Bd, donde: SQL | undefined) {
	await db.transaction(async (tx) => {
		await tx.execute(sql`set local session_replication_role = replica`);
		await tx.delete(auditoria).where(donde);
	});
}
