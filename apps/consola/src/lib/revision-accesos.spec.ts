import { describe, expect, it } from 'vitest';
import {
	aDesactivar,
	diasValidos,
	esUltimoAdmin,
	origenCuenta,
	proximaRevision,
	revisionVencida,
	type CuentaAcceso
} from './revision-accesos';

const DIA = 86_400_000;
const ahora = Date.parse('2026-11-15T12:00:00Z');
const hace = (dias: number) => new Date(ahora - dias * DIA);
const cuenta = (
	oid: string,
	dias: number,
	roles: string[] = ['lector'],
	extra = {}
): CuentaAcceso => ({
	oid,
	roles,
	visto: hace(400),
	ultimaEntrada: hace(dias),
	reactivada: null,
	desactivada: null,
	...extra
});

describe('desactivar por inactividad', () => {
	it('desactiva lo que pasa del plazo y deja lo reciente', () => {
		const r = aDesactivar([cuenta('a', 91), cuenta('b', 89), cuenta('c', 200)], 90, ahora);
		expect(r).toEqual(['c', 'a']);
	});

	it('nunca desactiva el último administrador activo, aunque no entre', () => {
		expect(aDesactivar([cuenta('admin', 300, ['admin']), cuenta('x', 5)], 90, ahora)).toEqual([]);
		/* Con dos administradores viejos, cae el más antiguo y se queda el otro. */
		expect(
			aDesactivar([cuenta('a1', 300, ['admin']), cuenta('a2', 100, ['admin'])], 90, ahora)
		).toEqual(['a1']);
		/* Un administrador ya desactivado no cuenta como el que queda. */
		expect(
			aDesactivar(
				[cuenta('a1', 300, ['admin'], { desactivada: hace(10) }), cuenta('a2', 100, ['admin'])],
				90,
				ahora
			)
		).toEqual([]);
	});

	it('la reactivación y el alta cuentan como entrada', () => {
		expect(aDesactivar([cuenta('r', 200, ['lector'], { reactivada: hace(3) })], 90, ahora)).toEqual(
			[]
		);
		expect(
			aDesactivar([{ ...cuenta('n', 0), ultimaEntrada: null, visto: hace(20) }], 90, ahora)
		).toEqual([]);
		expect(
			aDesactivar([{ ...cuenta('n', 0), ultimaEntrada: null, visto: hace(120) }], 90, ahora)
		).toEqual(['n']);
	});

	it('a mano tampoco se desactiva el último administrador', () => {
		const c = [cuenta('a', 1, ['admin']), cuenta('b', 1)];
		expect(esUltimoAdmin(c, 'a')).toBe(true);
		expect(esUltimoAdmin(c, 'b')).toBe(false);
		expect(esUltimoAdmin([...c, cuenta('a2', 1, ['admin'])], 'a')).toBe(false);
	});

	it('el plazo va de 30 a 365 días', () => {
		expect(diasValidos('90')).toBe(90);
		expect(diasValidos(30)).toBe(30);
		expect(diasValidos('29')).toBeNull();
		expect(diasValidos('366')).toBeNull();
		expect(diasValidos('9x')).toBeNull();
		expect(diasValidos('')).toBeNull();
	});
});

describe('la revisión trimestral', () => {
	it('toca un trimestre después de la última, o de la cuenta más antigua', () => {
		expect(proximaRevision(null, null)).toBeNull();
		expect(proximaRevision(hace(10), hace(500))?.getTime()).toBe(ahora + 82 * DIA);
		expect(revisionVencida(hace(93), hace(500), ahora)).toBe(true);
		expect(revisionVencida(hace(30), hace(500), ahora)).toBe(false);
		/* Una consola recién instalada no nace con la revisión vencida. */
		expect(revisionVencida(null, hace(5), ahora)).toBe(false);
		expect(revisionVencida(null, hace(100), ahora)).toBe(true);
	});

	it('el origen de la cuenta por su oid', () => {
		expect(origenCuenta('local:1')).toBe('local');
		expect(origenCuenta('oidc:https://idp:sub')).toBe('oidc');
		expect(origenCuenta('saml:1a2b3c4d:u-1')).toBe('saml');
		expect(origenCuenta('0000-1111')).toBe('entra');
	});
});
