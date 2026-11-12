import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { direccionConsolaDe } from './direccion-consola';

describe('direccionConsolaDe', () => {
	it('en modo fijo usa ORIGIN', () => {
		expect(direccionConsolaDe('https://consola.empresa.es', 'https://otra.local')).toBe(
			'https://consola.empresa.es'
		);
	});

	it('en modo «cualquier IP» (ORIGIN vacío) usa el nombre propio de la consola', () => {
		expect(direccionConsolaDe('', 'https://gestion.kebaps.local')).toBe(
			'https://gestion.kebaps.local'
		);
		expect(direccionConsolaDe(undefined, 'https://gestion.kebaps.local/')).toBe(
			'https://gestion.kebaps.local'
		);
	});

	it('conserva el puerto', () => {
		expect(direccionConsolaDe('', 'https://consola.local:8443')).toBe('https://consola.local:8443');
	});

	it('no acepta lo que no es HTTPS ni lo que no se entiende', () => {
		expect(direccionConsolaDe('http://consola.local', '')).toBeNull();
		expect(direccionConsolaDe('https://', undefined)).toBeNull();
		expect(direccionConsolaDe(undefined, undefined)).toBeNull();
	});

	it('un ORIGIN sin HTTPS no tapa un CONSOLA_URL bueno', () => {
		expect(direccionConsolaDe('http://localhost:5173', 'https://gestion.kebaps.local')).toBe(
			'https://gestion.kebaps.local'
		);
	});
});
