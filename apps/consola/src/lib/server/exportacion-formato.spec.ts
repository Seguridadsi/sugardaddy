/*
 * Las piezas de la exportación sin base de datos: el tar lo abre el `tar` del
 * sistema, la firma Ed25519 la comprueba la pública que va dentro, y los ajustes
 * salen sin secretos.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	QUITADO,
	entradaTar,
	finTar,
	firmarExportacion,
	lineaCef,
	sha256,
	sinSecretos,
	sumas
} from './exportacion-formato';

describe('tar de la exportación', () => {
	it('lo abre tar y cada fichero sale entero', () => {
		const t = new Date('2026-11-15T10:00:00Z');
		const a = Buffer.from('{"a":1}\n'.repeat(1000));
		const b = Buffer.alloc(512, 0x41);
		const vacio = Buffer.alloc(0);
		const tar = Buffer.concat([
			...entradaTar('events/events-0001.jsonl', a, t),
			...entradaTar('audit/b.bin', b, t),
			...entradaTar('users/vacio.jsonl', vacio, t),
			finTar()
		]);
		expect(tar.length % 512).toBe(0);
		const dir = mkdtempSync(join(tmpdir(), 'sd-export-'));
		writeFileSync(join(dir, 'x.tar'), tar);
		execFileSync('tar', ['-xf', 'x.tar'], { cwd: dir });
		expect(readFileSync(join(dir, 'events/events-0001.jsonl')).equals(a)).toBe(true);
		expect(readFileSync(join(dir, 'audit/b.bin')).equals(b)).toBe(true);
		expect(readFileSync(join(dir, 'users/vacio.jsonl')).length).toBe(0);
	});

	it('no acepta nombres que no caben', () => {
		expect(() => entradaTar('x'.repeat(120), Buffer.alloc(1), new Date())).toThrow(/too long/);
	});

	it('SHA256SUMS en el formato de sha256sum -c', () => {
		const f = { ruta: 'a.txt', tabla: null, formato: 'text' as const, filas: null, bytes: 4 };
		expect(sumas([{ ...f, sha256: sha256('hola') }])).toBe(`${sha256('hola')}  a.txt\n`);
		expect(sha256('hola')).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('sin secretos', () => {
	it('quita claves, secretos, hashes y valores cifrados, y deja lo demás', () => {
		const r = sinSecretos({
			canal: {
				nodo: 'n1',
				clavePrivada: 'AAAA',
				clavePublica: 'BBBB',
				panel: 'https://central'
			},
			webhook: { url: 'https://x', secreto: 'abc' },
			entra: { clientId: 'id', clientSecret: 's' },
			lista: [{ token: 't', nombre: 'n' }],
			cifrado: 'v1.k1.aaaa.bbbb.cccc',
			nombre: 'Madrid'
		}) as Record<string, Record<string, unknown>>;
		expect(r.canal.clavePrivada).toBe(QUITADO);
		expect(r.canal.clavePublica).toBe('BBBB');
		expect(r.canal.nodo).toBe('n1');
		expect(r.webhook.secreto).toBe(QUITADO);
		expect(r.webhook.url).toBe('https://x');
		expect(r.entra.clientSecret).toBe(QUITADO);
		expect((r.lista as unknown as Record<string, string>[])[0].token).toBe(QUITADO);
		expect(r.cifrado).toBe(QUITADO);
		expect(r.nombre).toBe('Madrid');
	});
});

describe('CEF de un evento', () => {
	const nombres = {
		trampas: new Map([['t1', 'SSH | RRHH']]),
		sensores: new Map([['s1', 'Sensor A']])
	};
	const fila = {
		id: 'e1',
		cuando: '2026-11-15T10:00:00.123456+00:00',
		recibido: '2026-11-15T10:00:01.5+00:00',
		trampa: 't1',
		modulo: 'cowrie',
		tipo: 'contenedor',
		accion: 'autenticacion',
		severidad: 'alta',
		ip: '2001:db8::1',
		usuario: 'root=admin',
		conexion_establecida: true,
		alerta: null,
		sensor: 's1',
		linea: JSON.stringify({ origen: { puerto: 51234 }, detalle: { comando: 'ls\nid' } })
	};

	it('mismo mapeo que la salida syslog, escapado', () => {
		const l = lineaCef(fila, nombres, { id: 'nodo-1', nombre: 'Madrid' }, '0.30.0');
		expect(l.startsWith('CEF:0|SeguridadSI|Sugardaddy|0.30.0|trampa.autenticacion|')).toBe(true);
		expect(l).toContain('SSH \\| RRHH');
		expect(l).toContain(`|8|rt=${Date.parse('2026-11-15T10:00:00.123Z')} `);
		expect(l).toContain('c6a2=2001:db8::1');
		expect(l).not.toContain(' src=');
		expect(l).toContain('suser=root\\=admin');
		expect(l).toContain('spt=51234');
		expect(l).toContain('cs5={"comando":"ls\\\\nid"}');
		expect(l).toContain(`deviceCustomDate1=${Date.parse('2026-11-15T10:00:01.500Z')}`);
		expect(l).not.toContain('\n');
	});

	it('una línea que no es JSON no rompe nada', () => {
		const l = lineaCef(
			{ ...fila, ip: '203.0.113.9', linea: 'x' },
			nombres,
			{ id: 'n', nombre: 'n' },
			'dev'
		);
		expect(l).toContain(' src=203.0.113.9 ');
		expect(l).not.toContain('spt=');
	});
});

describe('firma del manifiesto', () => {
	it('Ed25519: la comprueba la pública que va en la exportación', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const privada = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
		const publica = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		const m = Buffer.from('{"x":1}\n');
		const f = firmarExportacion({ algoritmo: 'ed25519', privada, publica }, 'nodo-1', m);
		expect(f.manifiestoSha256).toBe(sha256(m));
		expect(f.texto).toBe(`sugardaddy/exportacion\nnodo-1\n${sha256(m)}`);
		expect(verify(null, Buffer.from(f.texto), f.publica!, Buffer.from(f.firma!, 'base64'))).toBe(
			true
		);
	});

	it('sin clave, sin firma (pero con el hash)', () => {
		const f = firmarExportacion(null, 'n', Buffer.from('a'));
		expect(f.algoritmo).toBe('none');
		expect(f.firma).toBeNull();
		expect(f.manifiestoSha256).toBe(sha256('a'));
	});

	it('HMAC con CLAVE_SECRETOS', () => {
		const f = firmarExportacion(
			{ algoritmo: 'hmac-sha256', secreto: '00'.repeat(32) },
			'n',
			Buffer.from('a')
		);
		expect(f.algoritmo).toBe('hmac-sha256');
		expect(f.firma).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});
});
