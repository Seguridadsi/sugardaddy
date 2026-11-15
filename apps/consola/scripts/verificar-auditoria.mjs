/*
 * Comprueba la auditoría de la consola: que ninguna entrada se ha cambiado,
 * quitado o colado (la cadena de hash, migración 0058) y que los sellos de cada
 * hora siguen casando y están bien firmados (docs/diseno/auditoria-inmutable.md).
 *
 *   sudo docker compose --env-file .env --env-file versiones.env exec consola node scripts/verificar-auditoria.mjs [--desde <id>] [--json]
 *
 * Sale con 0 si todo casa y con 1 si no (dice qué entradas y por qué). Solo lee.
 */
import postgres from 'postgres';
import { verificarAuditoria } from './auditoria.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--desde');
const desde = i >= 0 ? Number(args[i + 1]) : undefined;
const json = args.includes('--json');

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is missing from the environment.');
	process.exit(2);
}
if (desde !== undefined && !Number.isSafeInteger(desde)) {
	console.error('Usage: node scripts/verificar-auditoria.mjs [--desde <id>] [--json]');
	process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
	const [canal] = await sql`select valor from ajustes where clave = 'canal'`;
	const [nodo] = await sql`select valor from ajustes where clave = 'nodo'`;
	const c = canal
		? typeof canal.valor === 'string'
			? JSON.parse(canal.valor)
			: canal.valor
		: null;
	const n = nodo ? (typeof nodo.valor === 'string' ? JSON.parse(nodo.valor) : nodo.valor) : null;
	const secreto = (process.env.CLAVE_SECRETOS ?? '').trim();
	const r = await verificarAuditoria(sql, {
		desde,
		nodo: c?.nodo ?? n?.nodo ?? 'nodo',
		publica: c?.clavePublica ?? null,
		secreto: /^[0-9a-fA-F]{64}$/.test(secreto) ? secreto : null
	});
	if (json) console.log(JSON.stringify(r, null, 2));
	else {
		console.log(
			`${r.ok ? 'OK' : 'BROKEN'}: ${r.filas} entries checked` +
				(r.cabeza ? `, head ${r.cabeza.id} ${r.cabeza.hash}` : '') +
				`; seals ${r.sellos.bien} good, ${r.sellos.sinComprobar} unchecked, ${r.sellos.mal.length} bad`
		);
		for (const x of r.roturas) console.log(`  entry ${x.id}: ${x.motivo}`);
		for (const x of r.sellos.mal) console.log(`  seal ${x.id}: ${x.motivo}`);
	}
	process.exitCode = r.ok ? 0 : 1;
} finally {
	await sql.end();
}
