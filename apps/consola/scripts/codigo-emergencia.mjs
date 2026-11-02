/*
 * Código de emergencia del nodo: entrar como administrador una vez si se ha
 * perdido todo lo demás (contraseña, correo, Microsoft, llave). Lo crea el
 * instalador y lo enseña una sola vez; el cliente lo guarda fuera de la máquina.
 *
 *   node scripts/codigo-emergencia.mjs              crea uno nuevo (el anterior deja de valer)
 *   node scripts/codigo-emergencia.mjs --si-no-hay  solo si el nodo aún no tiene ninguno
 *
 * Imprime el código y nada más (o nada, si ya había uno y se pidió --si-no-hay).
 * El formato y el hash son los de src/lib/server/emergencia.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });

if (process.argv.includes('--si-no-hay')) {
	const [f] = await sql`select 1 from ajustes where clave = 'emergencia_codigo'`;
	if (f) {
		await sql.end();
		process.exit(0);
	}
}

const limpio = Array.from(randomBytes(24), (x) => ALFABETO[x & 31]).join('');
const valor = {
	hash: createHash('sha256').update(limpio).digest('hex'),
	creado: new Date().toISOString(),
	por: 'instalador'
};
await sql`insert into ajustes (clave, valor) values ('emergencia_codigo', ${JSON.stringify(valor)}::text::jsonb)
	on conflict (clave) do update set valor = excluded.valor`;
await sql`insert into auditoria (quien, accion) values ('instalador', 'código de emergencia generado')`;
await sql.end();
console.log(limpio.match(/.{4}/g).join('-'));
