/*
 * Carga los datos de ejemplo en una base de datos vacía.
 *
 * Los eventos se encadenan de verdad, sensor a sensor, como lo haría el sensor
 * real: así la verificación de la cadena se puede probar desde el primer día.
 * Cada sensor recibe un token nuevo; se guardan en .sensores.dev.json (fuera
 * del repositorio) para arrancar sensores de prueba.
 *
 * Uso:  npm run db:semilla            (no toca una base de datos con datos)
 *       npm run db:semilla -- --reiniciar
 */

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { GENESIS, hashEvento } from '@sugardaddy/contrato';
import * as s from '../src/lib/server/db/schema.ts';
import * as ejemplo from './datos-ejemplo.ts';
import { completarDestinos } from './destinos.mjs';

const conexion = postgres(process.env.DATABASE_URL ?? '');
const db = drizzle(conexion);

const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.sensores);
if (n > 0 && !process.argv.includes('--reiniciar')) {
	console.log('La base de datos ya tiene datos. Usa --reiniciar para empezar de cero.');
	await conexion.end();
	process.exit(0);
}

await db.execute(
	sql`truncate auditoria, ajustes, listas, aprobaciones, reglas, eventos, trampas, destinos, sensores restart identity cascade`
);

const tokens: Record<string, string> = {};
await db.insert(s.sensores).values(
	ejemplo.sensores.map((x) => {
		const token = randomBytes(32).toString('base64url');
		tokens[x.id] = token;
		return {
			id: x.id,
			nombre: x.nombre,
			red: x.red,
			vlan: x.vlan,
			claveHash: createHash('sha256').update(token).digest('hex'),
			ultimoLatido: new Date(x.ultimoLatido)
		};
	})
);

await db.insert(s.trampas).values(ejemplo.trampas.map((x) => ({ ...x, parametros: {} })));

/* Del más antiguo al más reciente, encadenando por sensor. */
const ultimo: Record<string, string> = {};
const filas = [...ejemplo.eventos].reverse().map((e) => {
	const linea = JSON.stringify({ ...e, hashAnterior: ultimo[e.sensor] ?? GENESIS });
	const hash = hashEvento(linea);
	ultimo[e.sensor] = hash;
	return {
		id: e.id,
		sensor: e.sensor,
		linea,
		hash,
		cuando: new Date(e.cuando),
		trampa: e.trampa.id,
		modulo: e.trampa.modulo,
		tipo: e.trampa.tipo,
		accion: e.accion,
		severidad: e.severidad,
		ip: e.origen.ip ?? null,
		usuario: e.origen.usuario ?? null,
		conexionEstablecida: e.conexionEstablecida
	};
});
await db.insert(s.eventos).values(filas);
/* Como al arrancar: cada sensor con su destino, y cada trampa con el suyo y su colocación. */
await completarDestinos(conexion);
for (const [sensor, hash] of Object.entries(ultimo))
	await db
		.update(s.sensores)
		.set({ ultimoHash: hash })
		.where(sql`id = ${sensor}`);

await db.insert(s.reglas).values(
	ejemplo.reglas.map((r) => ({
		id: r.id,
		nombre: r.nombre,
		severidadMinima: r.severidadMinima,
		trampas: r.trampas === 'todos' ? null : r.trampas,
		respuestas: r.respuestas,
		activa: r.activa
	}))
);

await db.insert(s.aprobaciones).values(
	ejemplo.aprobaciones.map((a) => ({
		regla: a.regla,
		respuesta: a.respuesta,
		objetivo: a.objetivo,
		evento: a.evento,
		creado: new Date(a.cuando)
	}))
);

await db
	.insert(s.listas)
	.values(ejemplo.listas.map((l) => ({ ...l, caduca: l.caduca ? new Date(l.caduca) : null })));

await db.insert(s.ajustes).values([
	{ clave: 'comparticion', valor: { compartir: true, recibir: true } },
	{ clave: 'nodo', valor: ejemplo.cliente }
]);
await db.insert(s.auditoria).values({ quien: 'semilla', accion: 'datos de ejemplo cargados' });

writeFileSync('.sensores.dev.json', JSON.stringify(tokens, null, '\t') + '\n', { mode: 0o600 });
console.log(
	`Cargados ${ejemplo.sensores.length} sensores, ${filas.length} eventos y ${ejemplo.listas.length} entradas de lista.`
);
console.log('Tokens de los sensores en .sensores.dev.json');
await conexion.end();
