/*
 * El generador de QR. Las huellas de abajo son de códigos que se comprobaron
 * leyéndolos con un lector de verdad (zxing-cpp) al escribir qr.ts: si cambian,
 * vuelve a comprobar que se leen antes de actualizarlas.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { matrizQr, qrDataUri, qrSvg } from './qr';

const huella = (m: boolean[][]) =>
	createHash('sha256')
		.update(m.map((f) => f.map((b) => (b ? 1 : 0)).join('')).join('\n'))
		.digest('hex');

const OTPAUTH =
	'otpauth://totp/Sugardaddy:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Sugardaddy&algorithm=SHA1&digits=6&period=30';

describe('QR', () => {
	it('elige la versión más pequeña que cabe (corrección M)', () => {
		expect(matrizQr('hi')).toHaveLength(21);
		expect(matrizQr('x'.repeat(40))).toHaveLength(29);
		expect(matrizQr(OTPAUTH)).toHaveLength(49);
		expect(matrizQr('w'.repeat(200))).toHaveLength(57);
		expect(() => matrizQr('w'.repeat(300))).toThrow();
	});

	it('pone los tres buscadores y el patrón de tiempo', () => {
		const m = matrizQr('hi');
		const n = m.length;
		for (const [x, y] of [
			[0, 0],
			[n - 7, 0],
			[0, n - 7]
		]) {
			expect(m[y].slice(x, x + 7)).toEqual(Array(7).fill(true));
			expect(m[y + 1].slice(x, x + 7)).toEqual([true, false, false, false, false, false, true]);
			expect(m[y + 3].slice(x, x + 7)).toEqual([true, false, true, true, true, false, true]);
		}
		for (let i = 8; i < n - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
		/* El módulo oscuro fijo. */
		expect(m[n - 8][8]).toBe(true);
	});

	it('da siempre la misma matriz (comprobada con un lector)', () => {
		expect(huella(matrizQr(OTPAUTH))).toBe(
			'5a75c1602bc8dfec86fbc3b2db58fa93df080dfa7bf721a6befc6386d36929ff'
		);
		expect(huella(matrizQr('w'.repeat(200)))).toBe(
			'8c9fdd4ce3270b999e82bb4818058cca051430a6dbb26a2195496650239f92e5'
		);
	});

	it('sale como SVG con margen, y como imagen data:', () => {
		const svg = qrSvg('hi');
		expect(svg).toContain('viewBox="0 0 29 29"');
		expect(svg).not.toMatch(/<script/i);
		expect(qrDataUri('hi')).toMatch(/^data:image\/svg\+xml;base64,/);
	});
});
