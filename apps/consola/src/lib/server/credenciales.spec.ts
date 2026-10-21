import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {}, schema: {} }));
vi.mock('./catalogo', () => ({ honeycosas: () => [], traductorDeTrampa: () => undefined }));

const { alertaPara, credencialDe, normalizar } = await import('./credenciales');

describe('alerta por el nombre de la empresa', () => {
	const lista = ['Aldanza'];

	it('salta si la contraseña contiene la palabra, sin importar mayúsculas ni tildes', () => {
		expect(alertaPara('ALDANZA2024!', null, lista)).toBe('La contraseña contiene «Aldanza»');
		expect(alertaPara('aldánza', null, lista)).not.toBeNull();
	});

	it('salta si la contiene el usuario', () => {
		expect(alertaPara('123456', 'admin.aldanza', lista)).toBe('El usuario contiene «Aldanza»');
	});

	it('no salta con variantes ni parecidos: solo la palabra tal cual', () => {
		expect(alertaPara('4ld4nz4', null, lista)).toBeNull();
		expect(alertaPara('Ald@nza', null, lista)).toBeNull();
		expect(alertaPara('grupo-gal', 'gal', lista)).toBeNull();
	});

	it('sin palabras, nunca salta', () => {
		expect(alertaPara('aldanza', 'aldanza', [])).toBeNull();
	});

	it('normaliza solo mayúsculas y tildes', () => {
		expect(normalizar('ÁLDÁNZA')).toBe('aldanza');
	});
});

describe('contraseña de un evento', () => {
	/* El campo que dice el traductor de su vía (en Cowrie, password). */
	const campo = 'password';
	const base = {
		version: 2 as const,
		id: '6f1c2b1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
		cuando: '2026-10-15T09:00:00Z',
		trampa: { id: 'ssh-1', modulo: 'cowrie', tipo: 'contenedor' as const },
		sensor: 'local',
		origen: { ip: '203.0.113.9', usuario: 'root' },
		accion: 'autenticacion' as const,
		severidad: 'alta' as const,
		conexionEstablecida: true,
		hashAnterior: '0'.repeat(64)
	};

	it('la saca del campo que dice el manifiesto y sube a crítico si es alerta', () => {
		const c = credencialDe({ ...base, detalle: { password: 'Aldanza1' } }, campo, ['aldanza']);
		expect(c).toEqual({
			contrasena: 'Aldanza1',
			alerta: 'La contraseña contiene «aldanza»',
			severidad: 'critica'
		});
	});

	it('sin alerta conserva la severidad del sensor', () => {
		const c = credencialDe({ ...base, detalle: { password: 'toor' } }, campo, ['aldanza']);
		expect(c).toEqual({ contrasena: 'toor', alerta: null, severidad: 'alta' });
	});

	it('un módulo sin login no tiene contraseña', () => {
		const otro = {
			...base,
			trampa: { ...base.trampa, modulo: 'baliza' },
			detalle: { password: 'x' }
		};
		expect(credencialDe(otro, undefined, []).contrasena).toBeNull();
	});
});
