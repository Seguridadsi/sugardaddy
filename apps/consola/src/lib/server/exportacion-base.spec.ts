/*
 * La exportación completa contra una base de verdad. DATABASE_URL (del entorno o
 * de .env); si no hay, se salta. Se descarga entera, se abre con el `tar` del
 * sistema y se comprueba como lo haría el cliente: SHA256SUMS, la firma del
 * manifiesto, la cadena de la auditoría y que no sale ningún secreto.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const { exportacionCompleta, historialExportaciones } = hayBase
	? await import('./exportacion')
	: ({} as never);
const { eq, inArray } = await import('drizzle-orm');

const QUIEN = 'zz-exportacion@prueba';
const SENSOR = 'zz-export-sensor';
const TRAMPA = 'zz-export-trampa';
const USUARIO = 'zz-export-usuario';
const SALIDA = '00000000-0000-4000-8000-00000000e0e1';
const EVENTOS = ['00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000e002'];
/* B-09: uno ya cifrado y uno de antes de la 0063 (el nodo aún sin clave). */
const CIFRADO = '00000000-0000-4000-8000-00000000e003';
const ANTIGUO = '00000000-0000-4000-8000-00000000e004';
const TODOS = [...EVENTOS, CIFRADO, ANTIGUO];
let canalAntes: unknown = undefined;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function limpiar() {
	await db.delete(s.eventos).where(inArray(s.eventos.id, TODOS));
	await db.delete(s.trampas).where(eq(s.trampas.id, TRAMPA));
	await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
	await db.delete(s.usuariosLocales).where(eq(s.usuariosLocales.id, USUARIO));
	await db.delete(s.salidas).where(eq(s.salidas.id, SALIDA));
}

async function leer(r: ReadableStream<Uint8Array>): Promise<Buffer> {
	const trozos: Buffer[] = [];
	for await (const t of r as unknown as AsyncIterable<Uint8Array>) trozos.push(Buffer.from(t));
	return Buffer.concat(trozos);
}

/* Espera a que la auditoría diga cómo acabó (se escribe después del último byte). */
async function final(desdeId: number) {
	for (let i = 0; i < 50; i++) {
		const h = (await historialExportaciones(5)).find((x) => x.id > desdeId && x.quien === QUIEN);
		if (h) return h;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error('no audit entry for the export');
}

describe.skipIf(!hayBase)('exportación completa', () => {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');

	beforeAll(async () => {
		await limpiar();
		const [c] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
		canalAntes = c?.valor;
		const canal = {
			...((c?.valor as object) ?? {}),
			nodo: 'zz-nodo-export',
			clavePrivada: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
			clavePublica: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
		};
		await db
			.insert(s.ajustes)
			.values({ clave: 'canal', valor: canal })
			.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: canal } });
		await db
			.insert(s.sensores)
			.values({ id: SENSOR, nombre: 'Export sensor', claveHash: 'HASH-SECRETO-SENSOR' });
		await db.insert(s.trampas).values({
			id: TRAMPA,
			nombre: 'Export decoy',
			modulo: 'cowrie',
			tipo: 'contenedor',
			sensor: SENSOR,
			donde: 'x'
		});
		for (const [i, id] of EVENTOS.entries())
			await db.insert(s.eventos).values({
				id,
				sensor: SENSOR,
				linea: JSON.stringify({ origen: { puerto: 2200 + i } }),
				hash: 'h' + i,
				cuando: new Date(Date.UTC(2026, 10, 15, 10, i)),
				trampa: TRAMPA,
				modulo: 'cowrie',
				tipo: 'contenedor',
				accion: 'autenticacion',
				severidad: 'alta',
				ip: '203.0.113.' + (i + 1),
				usuario: 'root',
				conexionEstablecida: true
			});
		const comun = {
			sensor: SENSOR,
			cuando: new Date(Date.UTC(2026, 10, 15, 11)),
			trampa: TRAMPA,
			modulo: 'cowrie',
			tipo: 'contenedor',
			accion: 'autenticacion',
			severidad: 'alta' as const,
			ip: '203.0.113.9',
			usuario: 'root',
			conexionEstablecida: true
		};
		await db.insert(s.eventos).values({
			...comun,
			id: CIFRADO,
			hash: 'h-cifrado',
			linea: JSON.stringify({ detalle: { password: 'P**********26' } }),
			credencial: 'v1.k.SOBRE.CREDENCIAL.x',
			contrasenaHuella: 'HUELLA-HMAC-CREDENCIAL',
			contrasenaMascara: 'P**********26'
		});
		await db.insert(s.eventos).values({
			...comun,
			id: ANTIGUO,
			hash: 'h-antiguo',
			linea: JSON.stringify({
				detalle: { password: 'ClaveVieja-EnClaro-1', campo_raro: 'OtraVieja-EnClaro-2' }
			}),
			contrasena: 'OtraVieja-EnClaro-2'
		});
		await db.insert(s.usuariosLocales).values({
			id: USUARIO,
			usuario: 'zz-export',
			nombre: 'Export user',
			correo: 'export@example.com',
			claveHash: 'HASH-SECRETO-USUARIO',
			roles: ['admin'],
			creadaPor: QUIEN
		});
		/* B-10: el segundo factor no sale (ni el secreto TOTP ni los códigos). */
		await db.insert(s.factoresUsuario).values({
			id: 'zz-export-factor',
			usuarioId: USUARIO,
			tipo: 'totp',
			nombre: 'Phone',
			secreto: 'v1.k.SECRETO.TOTP.x'
		});
		await db
			.insert(s.codigosRecuperacionMfa)
			.values({ usuarioId: USUARIO, hash: 'HASH-RECUPERACION-MFA' });
		await db.insert(s.salidas).values({
			id: SALIDA,
			tipo: 'webhook',
			nombre: 'Export output',
			secretosCifrados: 'v1.k.SECRETO.SALIDA.x',
			reglas: { severidadMinima: 'baja' } as never
		});
	});

	afterAll(async () => {
		await limpiar();
		if (canalAntes === undefined) await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'canal'));
		else await db.update(s.ajustes).set({ valor: canalAntes }).where(eq(s.ajustes.clave, 'canal'));
	});

	it('el archivo se comprueba entero y no lleva secretos', async () => {
		const antes = (await historialExportaciones(1))[0]?.id ?? 0;
		const gz = await leer(await exportacionCompleta(QUIEN));
		const dir = mkdtempSync(join(tmpdir(), 'sd-export-base-'));
		writeFileSync(join(dir, 'x.tar'), gunzipSync(gz));
		execFileSync('tar', ['-xf', 'x.tar'], { cwd: dir });

		/* 1. SHA256SUMS: cada fichero casa. */
		const sumas = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
		expect(sumas.length).toBeGreaterThan(20);
		for (const l of sumas) {
			const [h, ruta] = l.split('  ');
			expect(sha(readFileSync(join(dir, ruta))), ruta).toBe(h);
		}

		/* 2. La firma del manifiesto, con la pública que va dentro. */
		const manifiesto = readFileSync(join(dir, 'manifest.json'));
		const firma = JSON.parse(readFileSync(join(dir, 'manifest.sig.json'), 'utf8'));
		expect(firma.algoritmo).toBe('ed25519');
		expect(firma.manifiestoSha256).toBe(sha(manifiesto));
		const pem = readFileSync(join(dir, 'public-key.pem'), 'utf8');
		expect(verify(null, Buffer.from(firma.texto), pem, Buffer.from(firma.firma, 'base64'))).toBe(
			true
		);

		/* 3. Los eventos, en JSON Lines y en CEF. */
		const m = JSON.parse(manifiesto.toString());
		expect(m.formato).toBe('sugardaddy-export/1');
		const eventos = readFileSync(join(dir, 'events/events-0001.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		const nuestros = eventos.filter((e) => EVENTOS.includes(e.id));
		expect(nuestros).toHaveLength(2);
		expect(nuestros[0].ip).toBe('203.0.113.1');
		const cef = readFileSync(join(dir, 'events/events-0001.cef'), 'utf8');
		expect(cef).toContain(`externalId=${EVENTOS[0]}`);
		expect(cef).toContain('cs1=Export decoy');
		expect(cef).toContain('spt=2201');

		/* 4. La cadena de la auditoría, sin Postgres, hasta la cabeza. */
		const filas = readdirSync(join(dir, 'audit'))
			.filter((f) => f.startsWith('audit-log-'))
			.sort()
			.flatMap((f) =>
				readFileSync(join(dir, 'audit', f), 'utf8')
					.trim()
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			);
		expect(filas.length).toBeGreaterThan(0);
		/*
		 * Cada fila casa con su hash. Que cada una cuelgue de la anterior no se mira aquí:
		 * la base de las pruebas es compartida y otras pruebas borran sus filas de
		 * auditoría (en un nodo de verdad solo borra la purga, y deja su fila).
		 */
		for (const f of filas) expect(sha(f.hash_anterior + f.canonica), `fila ${f.id}`).toBe(f.hash);
		const cabeza = JSON.parse(readFileSync(join(dir, 'audit/head.json'), 'utf8'));
		expect(cabeza.cabeza.hash).toBe(filas.at(-1).hash);
		expect(filas.some((f) => f.accion === 'full data export started' && f.quien === QUIEN)).toBe(
			true
		);

		/* 5. Ningún secreto. */
		const todo = readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && d.name !== 'x.tar')
			.map((d) => readFileSync(join(d.parentPath, d.name), 'utf8'))
			.join('\n');
		expect(todo).not.toContain('HASH-SECRETO-SENSOR');
		expect(todo).not.toContain('HASH-SECRETO-USUARIO');
		expect(todo).not.toContain('SECRETO.SALIDA');
		expect(todo).not.toContain('SECRETO.TOTP');
		expect(todo).not.toContain('HASH-RECUPERACION-MFA');
		expect(todo).not.toContain('SOBRE.CREDENCIAL');
		expect(todo).not.toContain('HUELLA-HMAC-CREDENCIAL');
		expect(todo).not.toContain('ClaveVieja-EnClaro-1');
		expect(todo).not.toContain('OtraVieja-EnClaro-2');
		const cifrado = eventos.find((e) => e.id === CIFRADO);
		expect(cifrado.contrasena_mascara).toBe('P**********26');
		expect(Object.keys(cifrado)).not.toContain('credencial');
		expect(Object.keys(cifrado)).not.toContain('contrasena_huella');
		expect(Object.keys(cifrado)).not.toContain('contrasena');
		expect(Object.keys(cifrado).some((k) => k.startsWith('__'))).toBe(false);
		const antiguo = JSON.parse(eventos.find((e) => e.id === ANTIGUO).linea);
		expect(antiguo.detalle.password).toMatch(/^C\*+…?-1$/);
		expect(antiguo.detalle.campo_raro).toMatch(/^O\*+…?-2$/);
		expect(todo).not.toContain(
			privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
		);
		expect(todo).toContain('Export user');

		/* 6. En la auditoría, con el hash del archivo que salió. */
		const h = await final(antes);
		expect(h.accion).toBe('full data export completed');
		expect(h.detalle.archivoSha256).toBe(sha(gz));
		expect(h.detalle.manifiestoSha256).toBe(sha(manifiesto));
		expect(h.detalle.bytes).toBe(gz.length);
	});

	it('si se corta la descarga, queda como fallida', async () => {
		const antes = (await historialExportaciones(1))[0]?.id ?? 0;
		const r = await exportacionCompleta(QUIEN);
		const lector = r.getReader();
		await lector.read();
		await lector.cancel();
		const h = await final(antes);
		expect(h.accion).toBe('full data export failed');
	});
});
