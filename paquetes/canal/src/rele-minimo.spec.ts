import { describe, expect, it } from 'vitest';
import {
	UA_RELE_MAX,
	dominioDeReferer,
	minimizarCargaRele,
	recortarUaRele
} from './rele-minimo.ts';

describe('lo mínimo de una señal del relé', () => {
	it('recorta el User-Agent sin partir un carácter', () => {
		expect(recortarUaRele('Microsoft Office Word')).toBe('Microsoft Office Word');
		const largo = 'a'.repeat(UA_RELE_MAX - 1) + '😀😀';
		const r = recortarUaRele(largo);
		expect(Array.from(r)).toHaveLength(UA_RELE_MAX);
		expect(r.endsWith('😀')).toBe(true);
		/* Recortar dos veces da lo mismo: el nodo compara por este recorte. */
		expect(recortarUaRele(r)).toBe(r);
	});

	it('del Referer deja solo el sitio', () => {
		expect(dominioDeReferer('https://ana:clave@Login.Ejemplo.com:8443/x?correo=a@b.c#f')).toBe(
			'login.ejemplo.com'
		);
		expect(dominioDeReferer('no es una url')).toBeUndefined();
		expect(dominioDeReferer('mailto:a@b.c')).toBeUndefined();
	});

	it('minimiza la carga y deja lo demás', () => {
		const c = minimizarCargaRele({
			token: 'tok',
			ip: '203.0.113.5',
			ua: 'x'.repeat(600),
			uaAtacante: 'y'.repeat(600),
			referer: 'https://intranet.cliente.example/rrhh/nominas?id=42',
			usuario: 'ana@cliente.example',
			path: '/b/tok'
		});
		expect((c.ua as string).length).toBe(UA_RELE_MAX);
		expect((c.uaAtacante as string).length).toBe(UA_RELE_MAX);
		expect(c.referer).toBe('intranet.cliente.example');
		expect(c).toMatchObject({ token: 'tok', ip: '203.0.113.5', path: '/b/tok' });
		expect(minimizarCargaRele({ referer: 'basura' })).not.toHaveProperty('referer');
	});
});
