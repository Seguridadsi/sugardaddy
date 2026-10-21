/*
 * Código de un solo uso para registrar una llave de emergencia cuando ya
 * nadie puede entrar en la consola. Solo lo puede sacar quien tiene acceso a
 * la máquina del nodo:
 *
 *   docker compose exec consola node scripts/emergencia.mjs
 *
 * Vale 30 minutos y para una sola llave.
 */
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
const codigo = randomBytes(24).toString('base64url');
const valor = {
	hash: createHash('sha256').update(codigo).digest('hex'),
	caduca: new Date(Date.now() + 30 * 60_000).toISOString()
};
await sql`insert into ajustes (clave, valor) values ('emergencia_alta', ${JSON.stringify(valor)}::jsonb)
	on conflict (clave) do update set valor = excluded.valor`;
await sql`insert into auditoria (quien, accion) values ('máquina del nodo', 'código de alta de emergencia generado')`;
await sql.end();
const base = process.env.ORIGIN ?? 'https://<consola>';
console.log(
	`Abre en un navegador, antes de 30 minutos:\n\n  ${base}/emergencia/alta?codigo=${codigo}\n`
);
