/*
 * Cabeceras de seguridad (plan de fortificación, 0.4): HSTS en toda respuesta
 * y una CSP también en lo que no es una página, sin pisar la que ya trae.
 */
import { describe, expect, it } from 'vitest';
import { CSP_SIN_PAGINA, HSTS, ponerCabeceras } from './cabeceras';

describe('cabeceras de seguridad', () => {
	it('HSTS siempre y la CSP cerrada donde no había ninguna', () => {
		const h = new Headers({ 'content-type': 'application/json' });
		ponerCabeceras(h);
		expect(h.get('strict-transport-security')).toBe(HSTS);
		expect(h.get('content-security-policy')).toBe(CSP_SIN_PAGINA);
		expect(CSP_SIN_PAGINA).toContain("default-src 'none'");
		expect(CSP_SIN_PAGINA).toContain("frame-ancestors 'none'");
		expect(h.get('x-frame-options')).toBe('DENY');
		expect(h.get('x-content-type-options')).toBe('nosniff');
	});

	it('no pisa la CSP de una página (kit.csp) ni la del informe', () => {
		const propia = "default-src 'none'; script-src 'self' 'nonce-abc'";
		const h = new Headers({ 'content-security-policy': propia });
		ponerCabeceras(h);
		expect(h.get('content-security-policy')).toBe(propia);
	});
});
