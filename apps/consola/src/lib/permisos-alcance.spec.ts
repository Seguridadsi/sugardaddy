/*
 * Mismo dato, un solo criterio (auditoría del 2026-11-14, h02): dejar de
 * enviar lo de un sensor o un honeypot a una salida pide `ajustes`, como en la
 * propia salida; enviar o heredar, `desplegar`.
 */
import { describe, expect, it } from 'vitest';
import { permisoDeAlcance, puede } from './permisos';

describe('permisoDeAlcance', () => {
	it('dejar de enviar es del administrador; enviar o heredar, de quien despliega', () => {
		expect(permisoDeAlcance(false)).toBe('ajustes');
		expect(permisoDeAlcance(true)).toBe('desplegar');
		expect(permisoDeAlcance(null)).toBe('desplegar');
		expect(permisoDeAlcance(undefined)).toBe('desplegar');
	});

	it('un operador puede enviar o heredar, pero no silenciar', () => {
		expect(puede(['operador'], permisoDeAlcance(true))).toBe(true);
		expect(puede(['operador'], permisoDeAlcance(null))).toBe(true);
		expect(puede(['operador'], permisoDeAlcance(false))).toBe(false);
		expect(puede(['admin'], permisoDeAlcance(false))).toBe(true);
	});
});
