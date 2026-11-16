import { createPrivateKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generarClaves } from './index.ts';
import {
	huellaSello,
	leerSelloLatido,
	textoSelloAuditoria,
	verificarSelloAuditoria
} from './sello-auditoria.ts';

const claves = generarClaves();
const firmar = (texto: string, privada = claves.privada) =>
	sign(
		null,
		Buffer.from(texto, 'utf8'),
		createPrivateKey({ key: Buffer.from(privada, 'base64'), format: 'der', type: 'pkcs8' })
	).toString('base64');

const base = {
	nodo: 'nodo-a',
	hasta: 42,
	hash: 'a'.repeat(64),
	cuando: '2026-11-16T10:00:00.000Z',
	algoritmo: 'ed25519' as const
};

describe('sello de la auditoría', () => {
	it('verifica la firma Ed25519 del nodo y rechaza la de otro nodo o un campo cambiado', () => {
		const firma = firmar(textoSelloAuditoria(base));
		expect(verificarSelloAuditoria({ ...base, firma }, claves.publica)).toBe(true);
		expect(verificarSelloAuditoria({ ...base, hasta: 43, firma }, claves.publica)).toBe(false);
		expect(verificarSelloAuditoria({ ...base, nodo: 'nodo-b', firma }, claves.publica)).toBe(false);
		expect(verificarSelloAuditoria({ ...base, firma }, generarClaves().publica)).toBe(false);
		expect(verificarSelloAuditoria({ ...base, firma }, 'no-es-una-clave')).toBe(false);
	});

	it('un sello HMAC no se puede comprobar desde fuera', () => {
		expect(
			verificarSelloAuditoria({ ...base, algoritmo: 'hmac-sha256', firma: 'AAAA' }, claves.publica)
		).toBeNull();
	});

	it('la huella es la de la consola (16 hex del SHA-256 del DER)', () => {
		expect(huellaSello(claves.publica)).toMatch(/^[0-9a-f]{16}$/);
	});

	it('del latido solo acepta un sello bien formado', () => {
		const bien = {
			hasta: 7,
			hash: 'b'.repeat(64),
			cuando: base.cuando,
			algoritmo: 'ed25519',
			firma: 'QUJD'
		};
		expect(leerSelloLatido(bien)).toEqual(bien);
		expect(leerSelloLatido({ ...bien, extra: 1 })).toEqual(bien);
		for (const mal of [
			null,
			'x',
			{ ...bien, hasta: 0 },
			{ ...bien, hasta: 1.5 },
			{ ...bien, hash: 'B'.repeat(64) },
			{ ...bien, cuando: 'ayer' },
			{ ...bien, algoritmo: 'rsa' },
			{ ...bien, firma: 'x'.repeat(201) },
			{ ...bien, firma: '<script>' }
		])
			expect(leerSelloLatido(mal)).toBeNull();
	});
});
