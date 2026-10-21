import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

/* Al compilar se cargan los módulos pero no se consulta nada; postgres solo conecta en la primera consulta. */
if (!env.DATABASE_URL && !building)
	throw new Error('Falta DATABASE_URL: copia .env.example a .env');

/*
 * La base de datos vive en el mismo nodo que la consola, así que la conexión
 * no sale de la máquina y no lleva TLS.
 */
export const db = drizzle(postgres(env.DATABASE_URL ?? '', { max: 10 }), { schema });

/*
 * Las salidas (avisos y SIEM, lib/server/salidas) van por sus propias dos
 * conexiones: por mucho que tengan que encolar o enviar, nunca dejan sin
 * conexión a la recepción de eventos ni a las páginas.
 */
export const dbSalidas = drizzle(postgres(env.DATABASE_URL ?? '', { max: 2 }), { schema });
export { schema };
