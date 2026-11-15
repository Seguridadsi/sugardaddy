import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	hojaDe,
	huellaTexto,
	incluida,
	leerRegistro,
	pruebaDe,
	raizDe,
	rutaDe,
	versionEnRegistro,
	type EntradaRegistro
} from './index.ts';

const entrada = (n: number, extra: Partial<EntradaRegistro> = {}) =>
	JSON.stringify({
		n,
		tipo: 'licencia',
		huella: huellaTexto(`doc ${n}`),
		clave: '0123456789abcdef',
		cuando: '2026-11-14T00:00:00Z',
		...extra
	});

describe('registro de transparencia (Merkle, RFC 6962)', () => {
	it('las rutas de todas las hojas llevan a la raíz, para cualquier tamaño', () => {
		for (let n = 1; n <= 33; n++) {
			const hojas = Array.from({ length: n }, (_, i) => hojaDe(entrada(i)));
			const raiz = raizDe(hojas);
			for (let i = 0; i < n; i++) {
				expect(incluida(hojas[i], i, n, rutaDe(hojas, i), raiz)).toBe(true);
				if (n > 1) {
					expect(incluida(hojas[i], (i + 1) % n, n, rutaDe(hojas, i), raiz)).toBe(false);
					expect(incluida(hojaDe('otra'), i, n, rutaDe(hojas, i), raiz)).toBe(false);
				}
			}
		}
	});

	it('la raíz de RFC 6962 para tamaños conocidos', () => {
		// Vacío: sha256(""). Una hoja: sha256(0x00 || dato).
		expect(raizDe([]).toString('hex')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		expect(raizDe([hojaDe('')]).toString('hex')).toBe(
			'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d'
		);
	});

	it('una versión está si su entrada y su ruta cuadran con la cabeza', () => {
		const texto = '{"version":"0.30.0"}';
		const lineas = [
			entrada(0),
			entrada(1, { tipo: 'version', huella: huellaTexto(texto), etiqueta: '0.30.0 cloud' }),
			entrada(2)
		];
		const { cabeza } = leerRegistro(lineas.join('\n') + '\n');
		const p = pruebaDe(lineas, 1);
		expect(versionEnRegistro(texto, cabeza, p)).toBe(true);
		expect(versionEnRegistro('{"version":"0.30.1"}', cabeza, p)).toBe(false);
		expect(versionEnRegistro(texto, cabeza, pruebaDe(lineas, 0))).toBe(false);
		expect(versionEnRegistro(texto, { ...cabeza, tamano: 4 }, p)).toBe(false);
	});

	it('un registro desordenado o con una entrada rara no se lee', () => {
		expect(() => leerRegistro(entrada(1))).toThrow(/out of order/);
		expect(() => leerRegistro(entrada(0, { tipo: 'otra' as never }))).toThrow(/type/);
	});

	it('el vector común con Go (vectores/transparencia.json)', () => {
		const v = JSON.parse(
			readFileSync(new URL('./vectores/transparencia.json', import.meta.url), 'utf8')
		);
		expect(leerRegistro(v.registro).cabeza).toEqual(v.cabeza);
		expect(versionEnRegistro(v.version, v.cabeza, v.prueba)).toBe(true);
	});
});
