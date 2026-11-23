/*
 * La comprobación de origen de los formularios (csrf.ts): la de SvelteKit, con
 * el ACS de SAML como única ruta que acepta un POST de otro origen.
 */
import { describe, expect, it } from 'vitest';
import { csrfRechaza } from './csrf';

const URLC = (ruta: string) => new URL(`https://consola.example${ruta}`);
const pet = (metodo: string, tipo: string | null, origen: string | null) =>
	new Request('https://consola.example/x', {
		method: metodo,
		headers: {
			...(tipo ? { 'content-type': tipo } : {}),
			...(origen ? { origin: origen } : {})
		},
		body: metodo === 'GET' ? undefined : 'a=1'
	});

describe('csrf', () => {
	it('rechaza formularios de otro origen o sin origen, como SvelteKit', () => {
		const ruta = URLC('/settings?/samlGuardar');
		for (const tipo of [
			'application/x-www-form-urlencoded',
			'multipart/form-data; boundary=x',
			'text/plain;charset=UTF-8',
			'application/x-sveltekit-formdata'
		]) {
			expect(csrfRechaza(pet('POST', tipo, 'https://malo.example'), ruta)).toBe(true);
			expect(csrfRechaza(pet('POST', tipo, null), ruta)).toBe(true);
			expect(csrfRechaza(pet('DELETE', tipo, 'null'), ruta)).toBe(true);
		}
	});

	it('deja pasar el mismo origen, JSON y los GET', () => {
		const ruta = URLC('/settings');
		expect(
			csrfRechaza(pet('POST', 'application/x-www-form-urlencoded', 'https://consola.example'), ruta)
		).toBe(false);
		expect(csrfRechaza(pet('POST', 'application/json', 'https://malo.example'), ruta)).toBe(false);
		expect(csrfRechaza(pet('GET', null, 'https://malo.example'), ruta)).toBe(false);
	});

	it('el ACS de SAML acepta el POST del proveedor; nada más se parece', () => {
		const idp = pet('POST', 'application/x-www-form-urlencoded', 'https://adfs.banco.example');
		expect(csrfRechaza(idp, URLC('/auth/saml/acs'))).toBe(false);
		expect(csrfRechaza(idp, URLC('/auth/saml/acs/'))).toBe(true);
		expect(csrfRechaza(idp, URLC('/auth/saml/acsx'))).toBe(true);
		expect(csrfRechaza(idp, URLC('/auth/saml/login'))).toBe(true);
	});
});
