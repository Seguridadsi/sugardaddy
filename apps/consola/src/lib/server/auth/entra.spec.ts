import { describe, expect, it } from 'vitest';
import { puede } from '$lib/permisos';
import { identidadDesdePayload, identidadPropia } from './entra';

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

describe('con el Entra propio del cliente', () => {
	const suyo = { oid: 'xyz', preferred_username: 'Luis@Kebaps.es', name: 'Luis', roles: ['admin'] };

	it('no hace falta grupo: basta un rol de Sugardaddy', () => {
		expect(identidadPropia(suyo)).toEqual({
			oid: 'xyz',
			correo: 'luis@kebaps.es',
			nombre: 'Luis',
			roles: ['admin'],
			soporte: false
		});
	});

	it('sin rol de Sugardaddy no entra, aunque traiga otros', () => {
		expect(identidadPropia({ ...suyo, roles: ['Global.Admin'] })).toEqual({ rechazo: 'sin_rol' });
		expect(identidadPropia({ ...suyo, roles: undefined })).toEqual({ rechazo: 'sin_rol' });
	});

	it('sin correo ni oid tampoco', () => {
		expect(identidadPropia({ ...suyo, preferred_username: 'luis' })).toEqual({
			rechazo: 'sin_correo'
		});
		expect(identidadPropia({ ...suyo, oid: undefined })).toEqual({ rechazo: 'sin_oid' });
	});
});

describe('el soporte de SeguridadSI, invitado en el tenant del cliente', () => {
	const SSI = '9601c73a-aa80-40bc-a17d-54b4f7738e92';
	const puerta = { correo: 'Kino@SeguridadSI.com', tenant: SSI, rol: 'lector' as const };
	const invitado = {
		oid: 'inv',
		email: 'kino@seguridadsi.com',
		name: 'Kino',
		roles: ['soporte'],
		acct: 1,
		idp: `https://sts.windows.net/${SSI}/`
	};

	it('entra con el soporte abierto, siendo quien lo pidió, y con el rol que eligió el cliente', () => {
		expect(identidadPropia(invitado, puerta)).toEqual({
			oid: 'inv',
			correo: 'kino@seguridadsi.com',
			nombre: 'Kino',
			roles: ['lector'],
			soporte: true
		});
		expect(
			identidadPropia({ ...invitado, idp: `https://login.microsoftonline.com/${SSI}/v2.0` }, puerta)
		).toMatchObject({ soporte: true });
	});

	it('con el soporte cerrado no entra, aunque tenga el rol en la aplicación', () => {
		expect(identidadPropia(invitado, null)).toEqual({ rechazo: 'soporte_cerrado' });
	});

	it('otra persona de SeguridadSI, un no invitado o alguien de otro tenant no entran', () => {
		expect(identidadPropia({ ...invitado, email: 'otro@seguridadsi.com' }, puerta)).toEqual({
			rechazo: 'soporte_otro'
		});
		expect(identidadPropia({ ...invitado, acct: 0 }, puerta)).toEqual({ rechazo: 'soporte_otro' });
		expect(identidadPropia({ ...invitado, acct: undefined }, puerta)).toEqual({
			rechazo: 'soporte_otro'
		});
		expect(
			identidadPropia(
				{ ...invitado, idp: 'https://sts.windows.net/11111111-1111-1111-1111-111111111111/' },
				puerta
			)
		).toEqual({ rechazo: 'soporte_otro' });
		expect(identidadPropia({ ...invitado, idp: undefined }, puerta)).toEqual({
			rechazo: 'soporte_otro'
		});
		/* Una petición sin tenant (de un panel antiguo) no abre la puerta. */
		expect(identidadPropia(invitado, { ...puerta, tenant: null })).toEqual({
			rechazo: 'soporte_otro'
		});
	});

	it('un empleado del cliente con el rol de soporte por error no entra como soporte', () => {
		expect(
			identidadPropia({ ...invitado, email: 'luis@kebaps.es', acct: 0, idp: undefined }, puerta)
		).toEqual({ rechazo: 'soporte_otro' });
	});
});
