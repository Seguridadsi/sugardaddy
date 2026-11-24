import { describe, expect, it } from 'vitest';
import {
	abrirMarca,
	buscarMarca,
	candidatas,
	claveDeTrampa,
	huellaVisitante,
	marcar,
	visitanteMarca
} from './marca-secretos';

/* Los mismos vectores que marca_nodo_test.go: si uno cambia, el otro lado deja de reconocerlas. */
const k = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const VECTORES = [
	['203.0.113.9', 'api', '9dc7968e69fa021731fdf2218438566a'],
	['203.0.113.9', 'deploy', '4784cd92926986c6909a318a82f07ff8'],
	['2001:db8:1:2:3:4:5:6', 'api', '3f9c8f36978f2235b0ee628d8e56aebb']
] as const;

describe('marca de secretos', () => {
	it('da lo mismo que la trampa en Go', () => {
		for (const [ip, uso, m] of VECTORES) expect(marcar(k, ip, uso)).toBe(m);
	});

	it('abre la marca con la huella de su visitante, y solo con su clave', () => {
		const m = marcar(k, '198.51.100.4', 'x');
		expect(abrirMarca(k, m)).toBe(huellaVisitante(k, '198.51.100.4'));
		expect(abrirMarca(claveDeTrampa(k, 'otra'), m)).toBeNull();
		const tocada = (m[0] === '0' ? '1' : '0') + m.slice(1);
		expect(abrirMarca(k, tocada)).toBeNull();
		expect(abrirMarca(k, '0123456789abcdef0123456789abcdef')).toBeNull();
		expect(abrirMarca(k, m.toUpperCase())).toBeNull();
	});

	it('dos secretos del mismo visitante salen distintos y apuntan a él', () => {
		const [a, b] = [marcar(k, '203.0.113.9', 'api'), marcar(k, '203.0.113.9', 'deploy')];
		expect(a).not.toBe(b);
		expect(abrirMarca(k, a)).toBe(abrirMarca(k, b));
	});

	it('el visitante es la IPv4 o el /64, como en Go', () => {
		expect(visitanteMarca('203.0.113.9')).toBe('203.0.113.9');
		expect(visitanteMarca('::ffff:203.0.113.9')).toBe('203.0.113.9');
		expect(visitanteMarca('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
		expect(visitanteMarca('2001:DB8:1:2:ffff::1')).toBe('2001:db8:1:2::/64');
		expect(visitanteMarca(' 198.51.100.4 ')).toBe('198.51.100.4');
		expect(visitanteMarca('fe80::1')).toBe('fe80::/64');
		expect(marcar(k, '2001:db8:1:2::1', 'api')).toBe(marcar(k, '2001:db8:1:2:9::9', 'api'));
	});

	it('la encuentra dentro de cualquier texto y dice de qué trampa es', () => {
		const portal = claveDeTrampa(k, 'portal');
		const claves = new Map([
			['s3', claveDeTrampa(k, 's3')],
			['portal', portal]
		]);
		const m = marcar(portal, '203.0.113.9', 'api');
		const evento = JSON.stringify({
			cabeceras: { authorization: `Bearer engk_${m}` },
			otro: 'a'.repeat(40)
		});
		expect(buscarMarca(evento, claves)).toEqual({
			trampa: 'portal',
			visitante: huellaVisitante(portal, '203.0.113.9'),
			marca: m
		});
		expect(buscarMarca(`ff${m}00`, claves)?.trampa).toBe('portal');
		expect(buscarMarca(`md5 d41d8cd98f00b204e9800998ecf8427e`, claves)).toBeNull();
	});

	it('mira poco aunque el texto sea todo hex', () => {
		expect(candidatas('ab'.repeat(100_000)).length).toBeLessThanOrEqual(16);
		expect(candidatas('nada que ver')).toEqual([]);
	});
});
