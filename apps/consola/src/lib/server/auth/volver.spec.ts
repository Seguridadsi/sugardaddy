/*
 * Adónde se vuelve tras entrar (volverSeguro, @sugardaddy/entra): solo a rutas
 * de la propia consola o del panel, también con lo que el navegador quita al
 * resolver (tabuladores, saltos de línea) o normaliza (barras invertidas).
 */
import { describe, expect, it } from 'vitest';
import { volverSeguro } from '@sugardaddy/entra';

describe('volverSeguro', () => {
	it('deja las rutas internas, con su consulta y su ancla', () => {
		expect(volverSeguro('/incidents')).toBe('/incidents');
		expect(volverSeguro('/decoys/abc?x=1#y')).toBe('/decoys/abc?x=1#y');
		expect(volverSeguro('/a/../b')).toBe('/b');
	});

	it.each([
		null,
		'',
		'incidents',
		'https://evil.example/',
		'//evil.example',
		'/\\evil.example',
		'/\t/evil.example',
		'/\n/evil.example',
		'/\r/evil.example',
		'/ /evil.example',
		'/x\\y',
		'/\u0000/evil.example',
		'/\u0085/evil.example'
	])('manda a la portada %j', (v) => {
		expect(volverSeguro(v)).toBe('/');
	});

	it('lo que deja, resuelto en cualquier origen, sigue en él', () => {
		for (const v of ['/a', '/%09/evil.example', '/%2F%2Fevil.example', '/a?u=//evil'])
			expect(new URL(volverSeguro(v), 'https://consola.example').origin).toBe(
				'https://consola.example'
			);
	});
});
