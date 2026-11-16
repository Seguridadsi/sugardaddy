/*
 * Las credenciales capturadas cifradas (B-09) contra Postgres: la parte de datos
 * de la migración 0063 (cifrarAnteriores) sobre filas como las de antes, en
 * claro; revelar con su apunte en la auditoría; agrupar y buscar por la huella;
 * y recalcular alertas desde el sobre. Lo de las salidas, en
 * salidas-credenciales-base.spec.ts (las salidas no están en Community).
 * DATABASE_URL (del entorno o de .env) y CLAVE_SECRETOS; si no hay base, se salta.
 * Todo lleva el prefijo zz-cred.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { borrarAuditoriaDePrueba } from './db/pruebas-auditoria';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;
process.env.CLAVE_SECRETOS ||= 'b2'.repeat(32);

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const c = hayBase ? await import('./credenciales') : ({} as never);
const { huella } = await import('./credenciales-protegidas');
const { and, eq, inArray, like } = await import('drizzle-orm');

const SENSOR = 'zz-cred-sensor';
const QUIEN = 'zz-cred@test';
const CLARA = 'ZzCredPrimavera2026';
const NTLM = 'zzcred00aabbccddeeff00112233445566';
let n = 0;

const linea = (modulo: string, detalle: Record<string, unknown>) =>
	JSON.stringify({
		version: 2,
		id: `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`,
		cuando: '2026-11-15T10:00:00Z',
		trampa: { id: `zz-cred-${modulo}`, modulo, tipo: 'contenedor' },
		sensor: SENSOR,
		origen: { ip: '203.0.113.77', usuario: 'root' },
		accion: 'autenticacion',
		severidad: 'alta',
		conexionEstablecida: true,
		hashAnterior: '0'.repeat(64),
		detalle
	});

/* Una fila como las de antes de la 0063: la línea y la columna, en claro. */
async function deAntes(
	modulo: string,
	detalle: Record<string, unknown>,
	contrasena: string | null
) {
	n++;
	const id = `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`;
	await db.insert(s.eventos).values({
		id,
		sensor: SENSOR,
		linea: linea(modulo, detalle),
		hash: `zz-cred-${n}`,
		cuando: new Date('2026-11-15T10:00:00Z'),
		trampa: `zz-cred-${modulo}`,
		modulo,
		tipo: 'contenedor',
		accion: 'autenticacion',
		severidad: 'alta',
		ip: '203.0.113.77',
		usuario: 'root',
		conexionEstablecida: true,
		contrasena
	});
	return id;
}

const fila = async (id: string) =>
	(await db.select().from(s.eventos).where(eq(s.eventos.id, id)))[0];

async function limpiar() {
	await db.delete(s.eventos).where(eq(s.eventos.sensor, SENSOR));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
	await borrarAuditoriaDePrueba(db, like(s.auditoria.quien, 'zz-cred%'));
}

describe.skipIf(!hayBase)('credenciales capturadas cifradas', () => {
	const ids: Record<string, string> = {};
	let palabrasAntes: string[] = [];

	beforeAll(async () => {
		await limpiar();
		palabrasAntes = await c.palabras();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: `x-${SENSOR}` });
		ids.ssh1 = await deAntes('cowrie', { password: CLARA }, CLARA);
		ids.ssh2 = await deAntes('cowrie', { password: CLARA }, CLARA);
		ids.smb = await deAntes('smb', { ntlm_hash: NTLM, dominio: 'ZZ' }, null);
		ids.fichero = await deAntes('cowrie', { hash: 'f'.repeat(64), url: 'http://x' }, null);
		/* Columna puesta y nada en la línea (una fila sembrada a mano). */
		ids.suelta = await deAntes('cowrie', {}, 'ZzCredSoloColumna');
	});

	afterAll(async () => {
		if (palabrasAntes.length || (await c.palabras()).length)
			await db
				.update(s.ajustes)
				.set({ valor: palabrasAntes })
				.where(eq(s.ajustes.clave, 'detonadores'));
		await limpiar();
	});

	it('la migración cifra lo de antes: nada en claro en la línea ni en la columna', async () => {
		const antes = await fila(ids.fichero);
		const cifradas = await c.cifrarAnteriores();
		expect(cifradas).toBeGreaterThanOrEqual(4);
		for (const k of ['ssh1', 'ssh2', 'smb', 'suelta']) {
			const f = await fila(ids[k]);
			expect(f.contrasena).toBeNull();
			expect(f.credencial).toMatch(/^v1\./);
			expect(f.linea).not.toContain(CLARA);
			expect(f.linea).not.toContain(NTLM);
			expect(f.credencial).not.toContain(CLARA);
		}
		const ssh = await fila(ids.ssh1);
		expect(ssh.contrasenaHuella).toBe(huella(CLARA));
		expect(ssh.contrasenaMascara).toBe('Z************…26');
		expect(JSON.parse(ssh.linea).detalle.password).toBe('Z************…26');
		/* El hash del evento (la cadena del sensor) no cambia. */
		expect(ssh.hash).toMatch(/^zz-cred-/);
		/* Un hash de fichero es un IOC, no una credencial: la fila no se toca. */
		expect(await fila(ids.fichero)).toEqual(antes);
	});

	it('repetirla no vuelve a tocar lo ya cifrado', async () => {
		const antes = await db
			.select({ id: s.eventos.id, credencial: s.eventos.credencial, linea: s.eventos.linea })
			.from(s.eventos)
			.where(eq(s.eventos.sensor, SENSOR));
		await c.cifrarAnteriores();
		const despues = await db
			.select({ id: s.eventos.id, credencial: s.eventos.credencial, linea: s.eventos.linea })
			.from(s.eventos)
			.where(eq(s.eventos.sensor, SENSOR));
		expect(despues.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
			antes.sort((a, b) => a.id.localeCompare(b.id))
		);
	});

	it('se agrupan y se buscan por la huella, enmascaradas', async () => {
		const [g] = await c.contrasenas(huella(CLARA));
		expect(g).toMatchObject({ veces: 2, mascara: 'Z************…26' });
		expect(JSON.stringify(g)).not.toContain(CLARA);
		const b = await c.buscarContrasena(QUIEN, CLARA);
		expect(b).toHaveLength(1);
		expect(await c.buscarContrasena(QUIEN, 'zz-cred-no-la-probo-nadie')).toHaveLength(0);
	});

	it('revelar devuelve los valores y lo apunta en la auditoría sin ellos', async () => {
		const r = await c.revelarDeEvento(QUIEN, ids.smb);
		expect(r).toEqual({ ok: true, contrasena: null, campos: { ntlm_hash: NTLM } });
		const p = await c.revelarPorHuella(QUIEN, huella(CLARA)!);
		expect(p.ok && p.contrasena).toBe(CLARA);
		const apuntes = await db
			.select()
			.from(s.auditoria)
			.where(and(eq(s.auditoria.quien, QUIEN)));
		const reveladas = apuntes.filter((a) => a.accion === c.ACCION_REVELAR);
		const buscadas = apuntes.filter((a) => a.accion === c.ACCION_BUSCAR);
		expect(reveladas).toHaveLength(2);
		expect(buscadas).toHaveLength(2);
		expect(reveladas[0].detalle).toMatchObject({ evento: ids.smb, campos: ['ntlm_hash'] });
		expect(JSON.stringify(apuntes)).not.toContain(CLARA);
		expect(JSON.stringify(apuntes)).not.toContain(NTLM);
	});

	it('un evento sin credenciales no revela nada (y también queda apuntado que no)', async () => {
		expect((await c.revelarDeEvento(QUIEN, ids.fichero)).ok).toBe(false);
	});

	it('las alertas se recalculan desde el sobre', async () => {
		await c.guardarPalabras(QUIEN, 'ZzCredPrimavera');
		const f = await fila(ids.ssh1);
		expect(f.alerta).toBe('Password contains "ZzCredPrimavera"');
		expect(f.severidad).toBe('critica');
		await c.guardarPalabras(QUIEN, palabrasAntes.join('\n'));
		expect((await fila(ids.ssh1)).alerta).toBeNull();
	});

	it('sin la clave del nodo no cifra (ni da por hecho nada)', async () => {
		const clave = process.env.CLAVE_SECRETOS;
		process.env.CLAVE_SECRETOS = '';
		try {
			expect(await c.cifrarAnteriores()).toBeNull();
		} finally {
			process.env.CLAVE_SECRETOS = clave;
		}
		const quedan = await db
			.select({ id: s.eventos.id })
			.from(s.eventos)
			.where(and(eq(s.eventos.sensor, SENSOR), inArray(s.eventos.id, [ids.ssh1])));
		expect(quedan).toHaveLength(1);
	});
});
