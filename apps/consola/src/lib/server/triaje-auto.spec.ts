/*
 * El cotejo del triaje automático y la agrupación de eventos, puros (sin base de
 * datos). Se mockea el entorno para que ./db no exija DATABASE_URL al importar.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Evento } from '@sugardaddy/contrato';
import type { ReglaTriaje } from './triaje-auto';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/environment', () => ({ building: true, dev: false }));

const { casaReglaTriaje, triajeDeReglas } = await import('./triaje-auto');
const { agruparEventos } = await import('./consultas');

/* Una regla mínima; los campos que el cotejo no mira dan igual. */
const regla = (r: Partial<ReglaTriaje>): ReglaTriaje =>
	({
		id: 'r',
		criterio: 'ip',
		valor: '',
		estado: 'revisado',
		nota: null,
		activa: true,
		quien: 'zz',
		creado: new Date(),
		...r
	}) as ReglaTriaje;

/* Un evento mínimo con lo que el cotejo lee. */
const evento = (e: Partial<Evento> & { origen?: Partial<Evento['origen']> }): Evento =>
	({
		id: 'e',
		cuando: '2026-10-02T00:00:00.000Z',
		accion: 'comando',
		severidad: 'alta',
		conexionEstablecida: true,
		trampa: { id: 't1', modulo: 'cowrie', tipo: 'contenedor' },
		...e,
		origen: { ...e.origen }
	}) as Evento;

describe('casaReglaTriaje', () => {
	it('ip: exacta y por rango CIDR (v4)', () => {
		const e = evento({ origen: { ip: '10.0.0.50' } });
		expect(casaReglaTriaje(regla({ criterio: 'ip', valor: '10.0.0.50' }), e)).toBe(true);
		expect(casaReglaTriaje(regla({ criterio: 'ip', valor: '10.0.0.0/24' }), e)).toBe(true);
		expect(casaReglaTriaje(regla({ criterio: 'ip', valor: '10.0.1.0/24' }), e)).toBe(false);
		expect(casaReglaTriaje(regla({ criterio: 'ip', valor: '203.0.113.9' }), e)).toBe(false);
	});

	it('ip: sin IP en el evento, nunca casa', () => {
		const e = evento({ origen: {} });
		expect(casaReglaTriaje(regla({ criterio: 'ip', valor: '10.0.0.0/8' }), e)).toBe(false);
	});

	it('ip: un patrón corrupto no lanza, no casa', () => {
		const e = evento({ origen: { ip: '10.0.0.50' } });
		expect(casaReglaTriaje(regla({ criterio: 'ip', valor: 'no-es-ip' }), e)).toBe(false);
	});

	it('usuario: exacto, sin importar mayúsculas', () => {
		const e = evento({ origen: { usuario: 'Root' } });
		expect(casaReglaTriaje(regla({ criterio: 'usuario', valor: 'root' }), e)).toBe(true);
		expect(casaReglaTriaje(regla({ criterio: 'usuario', valor: 'roo' }), e)).toBe(false);
	});

	it('comando: subcadena dentro de lo que tecleó (detalle) o la línea cruda', () => {
		const porDetalle = evento({ detalle: { input: 'cat /etc/passwd' } });
		expect(casaReglaTriaje(regla({ criterio: 'comando', valor: '/etc/passwd' }), porDetalle)).toBe(
			true
		);
		expect(casaReglaTriaje(regla({ criterio: 'comando', valor: 'PASSWD' }), porDetalle)).toBe(true);
		const porCrudo = evento({ crudo: 'GET /wp-login.php' });
		expect(casaReglaTriaje(regla({ criterio: 'comando', valor: 'wp-login' }), porCrudo)).toBe(true);
		expect(casaReglaTriaje(regla({ criterio: 'comando', valor: 'no-está' }), porCrudo)).toBe(false);
		/* NO casa por el NOMBRE del campo (la clave «input» la fija la trampa, no el atacante). */
		expect(casaReglaTriaje(regla({ criterio: 'comando', valor: 'input' }), porDetalle)).toBe(false);
	});

	it('trampa: por id exacto', () => {
		const e = evento({ trampa: { id: 't1', modulo: 'cowrie', tipo: 'contenedor' } });
		expect(casaReglaTriaje(regla({ criterio: 'trampa', valor: 't1' }), e)).toBe(true);
		expect(casaReglaTriaje(regla({ criterio: 'trampa', valor: 't2' }), e)).toBe(false);
	});

	it('un valor vacío nunca casa', () => {
		const e = evento({ origen: { ip: '10.0.0.1' } });
		expect(casaReglaTriaje(regla({ criterio: 'ip', valor: '  ' }), e)).toBe(false);
	});
});

describe('triajeDeReglas', () => {
	it('gana la primera regla que casa', () => {
		const e = evento({ origen: { ip: '10.0.0.5', usuario: 'root' } });
		const reglas = [
			regla({ criterio: 'usuario', valor: 'nadie', estado: 'interesante' }),
			regla({ criterio: 'ip', valor: '10.0.0.0/24', estado: 'falso-positivo', nota: 'rango propio' }),
			regla({ criterio: 'usuario', valor: 'root', estado: 'revisado' })
		];
		expect(triajeDeReglas(reglas, e)).toEqual({ estado: 'falso-positivo', nota: 'rango propio' });
	});

	it('null si ninguna casa', () => {
		const e = evento({ origen: { ip: '8.8.8.8' } });
		expect(triajeDeReglas([regla({ criterio: 'ip', valor: '10.0.0.0/8' })], e)).toBeNull();
	});
});

describe('agruparEventos', () => {
	const ev = (id: string, ip: string | null, trampa: string, accion: string, cuando: string) =>
		evento({
			id,
			accion: accion as Evento['accion'],
			cuando,
			origen: ip ? { ip } : {},
			trampa: { id: trampa, modulo: 'cowrie', tipo: 'contenedor' }
		});

	it('colapsa misma IP+trampa+acción, cuenta y lapso; representante el más reciente', () => {
		const lista = [
			ev('a', '1.1.1.1', 't1', 'comando', '2026-10-02T10:00:00.000Z'),
			ev('b', '1.1.1.1', 't1', 'comando', '2026-10-02T09:00:00.000Z'),
			ev('c', '1.1.1.1', 't1', 'comando', '2026-10-02T08:00:00.000Z'),
			ev('d', '2.2.2.2', 't1', 'comando', '2026-10-02T07:00:00.000Z')
		];
		const g = agruparEventos(lista as never);
		expect(g.length).toBe(2);
		expect(g[0].id).toBe('a');
		expect(g[0].repeticiones).toBe(3);
		expect(g[0].desde).toBe('2026-10-02T08:00:00.000Z');
		expect(g[0].hasta).toBe('2026-10-02T10:00:00.000Z');
		expect(g[1].id).toBe('d');
		expect(g[1].repeticiones).toBe(1);
	});

	it('distinta acción o distinta trampa no se agrupan', () => {
		const lista = [
			ev('a', '1.1.1.1', 't1', 'comando', '2026-10-02T10:00:00.000Z'),
			ev('b', '1.1.1.1', 't1', 'login', '2026-10-02T09:00:00.000Z'),
			ev('c', '1.1.1.1', 't2', 'comando', '2026-10-02T08:00:00.000Z')
		];
		expect(agruparEventos(lista as never).length).toBe(3);
	});
});
