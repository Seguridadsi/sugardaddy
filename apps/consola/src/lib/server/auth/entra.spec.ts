import { describe, expect, it } from 'vitest';
import { puede } from '$lib/permisos';
import { identidadDesdePayload } from './entra';

const GRUPO = '11111111-1111-1111-1111-111111111111';
const base = {
	oid: 'abc',
	email: 'Ana@Aldanza.es',
	name: 'Ana Ruiz',
	groups: [GRUPO],
	roles: ['aprobador']
};

describe('quién entra en este nodo', () => {
	it('un invitado del grupo del cliente y con rol entra, con el correo en minúsculas', () => {
		expect(identidadDesdePayload(base, GRUPO)).toEqual({
			oid: 'abc',
			correo: 'ana@aldanza.es',
			nombre: 'Ana Ruiz',
			roles: ['aprobador'],
			soporte: false
		});
	});

	it('un técnico de SeguridadSI entra solo con el soporte abierto, y con el rol que dio el cliente', () => {
		const tecnico = {
			...base,
			email: 'tec@seguridadsi.com',
			groups: ['grupo-soporte'],
			roles: ['admin']
		};
		expect(identidadDesdePayload(tecnico, GRUPO, null)).toEqual({ rechazo: 'sin_grupo' });
		expect(
			identidadDesdePayload(tecnico, GRUPO, { grupo: 'grupo-soporte', rol: 'lector' })
		).toMatchObject({
			roles: ['lector'],
			soporte: true
		});
	});

	it('un usuario de otro cliente no entra aunque tenga rol', () => {
		expect(identidadDesdePayload({ ...base, groups: ['otro-grupo'] }, GRUPO)).toEqual({
			rechazo: 'sin_grupo'
		});
	});

	it('sin ningún rol de la aplicación no entra', () => {
		expect(identidadDesdePayload({ ...base, roles: ['Global.Admin'] }, GRUPO)).toEqual({
			rechazo: 'sin_rol'
		});
	});

	it('los roles que no son de Sugardaddy se descartan', () => {
		const r = identidadDesdePayload({ ...base, roles: ['lector', 'superusuario'] }, GRUPO);
		expect(r).toMatchObject({ roles: ['lector'] });
	});

	it('si Entra no manda los grupos por ser demasiados, no se entra a ciegas', () => {
		const sinGrupos = { ...base, groups: undefined, _claim_names: { groups: 'src1' } };
		expect(identidadDesdePayload(sinGrupos, GRUPO)).toEqual({ rechazo: 'demasiados_grupos' });
	});

	it('el nombre de invitado #EXT# no sirve como correo', () => {
		const p = {
			...base,
			email: undefined,
			preferred_username: 'ana_aldanza.es#EXT#@seguridadsi.onmicrosoft.com'
		};
		expect(identidadDesdePayload(p, GRUPO)).toEqual({ rechazo: 'sin_correo' });
	});
});

describe('qué puede hacer cada rol', () => {
	it('un lector solo mira', () => {
		expect(puede(['lector'], 'ver')).toBe(true);
		expect(puede(['lector'], 'aprobar')).toBe(false);
		expect(puede(['lector'], 'listas')).toBe(false);
	});

	it('quien gestiona listas no aprueba contenciones', () => {
		expect(puede(['admin-listas'], 'listas')).toBe(true);
		expect(puede(['admin-listas'], 'aprobar')).toBe(false);
	});

	it('admin lo puede todo', () => {
		for (const p of ['ver', 'desplegar', 'aprobar', 'listas', 'ajustes'] as const)
			expect(puede(['admin'], p)).toBe(true);
	});
});
