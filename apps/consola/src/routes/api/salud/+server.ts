import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';

/* Para el actualizador: tras cambiar de imagen, la consola tiene que responder y llegar a su base de datos. */
export const GET = async () => {
	await db.execute(sql`select 1`);
	return json({ ok: true });
};
