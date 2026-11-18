import { describe, expect, it } from 'vitest';
import { leerPeticionClon } from './clonar-derecho';

describe('clonar una página exige confirmar el derecho a copiarla', () => {
	it('sin la confirmación no se clona', () => {
		for (const derecho of [undefined, false, 'true', 1, null]) {
			const r = leerPeticionClon({ url: 'https://intranet.example.com', derecho });
			expect(r.ok).toBe(false);
		}
	});
	it('con la confirmación y una dirección, sí', () => {
		expect(leerPeticionClon({ url: ' https://intranet.example.com ', derecho: true })).toEqual({
			ok: true,
			url: 'https://intranet.example.com'
		});
	});
	it('sin dirección no hay nada que clonar', () => {
		expect(leerPeticionClon({ derecho: true }).ok).toBe(false);
		expect(leerPeticionClon(null).ok).toBe(false);
	});
});
