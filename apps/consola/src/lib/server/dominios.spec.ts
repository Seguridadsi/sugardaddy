/* Validar/normalizar dominios y la cobertura de la lista blanca. Puro. */
import { describe, expect, it } from 'vitest';
import { cubreDominio, normalizarDominio } from './dominios';

describe('normalizarDominio', () => {
	it('normaliza mayúsculas, espacios, punto final y comodín', () => {
		expect(normalizarDominio('  Evil.Example.COM. ')).toBe('evil.example.com');
		expect(normalizarDominio('*.malo.net')).toBe('malo.net');
		expect(normalizarDominio('sub.dominio.co.uk')).toBe('sub.dominio.co.uk');
		expect(normalizarDominio('xn--nxasmq6b.com')).toBe('xn--nxasmq6b.com');
	});

	it('rechaza lo que no es un dominio', () => {
		for (const malo of [
			'',
			'  ',
			'localhost', // una sola etiqueta
			'example', // sin TLD
			'1.2.3.4', // IP (eso lo decide isIP antes)
			'exa mple.com', // espacio
			'-mal.com', // guion al borde
			'mal-.com',
			'ejemplo.123', // TLD numérico
			'http://x.com', // esquema
			'a@b.com' // arroba
		])
			expect(normalizarDominio(malo), malo).toBeNull();
	});
});

describe('cubreDominio', () => {
	const blanca = ['example.com', 'intra.acme.local'];
	it('tapa por coincidencia exacta y por subdominio', () => {
		expect(cubreDominio(blanca, 'example.com')).toBe(true);
		expect(cubreDominio(blanca, 'mail.example.com')).toBe(true);
		expect(cubreDominio(blanca, 'a.b.intra.acme.local')).toBe(true);
	});
	it('no tapa un dominio más amplio ni un parecido', () => {
		expect(cubreDominio(blanca, 'acme.local')).toBe(false); // la blanca es un subdominio suyo
		expect(cubreDominio(blanca, 'notexample.com')).toBe(false); // no es sufijo por etiqueta
		expect(cubreDominio(blanca, 'example.com.evil.net')).toBe(false);
		expect(cubreDominio([], 'example.com')).toBe(false);
	});
});
