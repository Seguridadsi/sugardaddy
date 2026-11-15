import { describe, expect, it } from 'vitest';
import {
	firmanteDePrivada,
	firmarCon,
	generarClaves,
	leerConfianza,
	textoOrden,
	verificarOrden,
	type Orden
} from './index.ts';

const publicacion = generarClaves();
const panel = generarClaves();
const firmar = (o: Orden | Record<string, unknown>, con = publicacion) => {
	const orden = JSON.stringify(o);
	return { orden, ...firmarCon(orden, firmanteDePrivada(con.privada)) };
};
const rele = (direccion: string | null): Orden => ({
	tipo: 'rele',
	version: 1,
	direccion,
	emitida: '2026-11-14T10:00:00.000Z'
});
const recuperacion: Orden = {
	tipo: 'recuperacion',
	version: 1,
	cliente: 'acme',
	id: '6f1d2b1e-3c4a-4d5e-8f90-1a2b3c4d5e6f',
	usuario: 'admin',
	codigoHash: `sha256$${'a'.repeat(32)}$${'b'.repeat(64)}`,
	caduca: '2026-11-14T11:00:00.000Z',
	emitida: '2026-11-14T10:00:00.000Z'
};

describe('órdenes firmadas con la clave de publicación', () => {
	it('una dirección de relé firmada con la de legado vale', () => {
		const v = verificarOrden(publicacion.publica, firmar(rele('rele.example.com')), 'rele');
		expect(v).toEqual({ ok: true, orden: rele('rele.example.com') });
	});

	it('también con una clave de uso delegaciones, y también para quitar el relé', () => {
		const c = leerConfianza(`delegaciones:${publicacion.publica}`, '');
		expect(verificarOrden(c, firmar(rele(null)), 'rele').ok).toBe(true);
	});

	it('firmada solo con la clave del panel, no vale', () => {
		const v = verificarOrden(publicacion.publica, firmar(rele('rele.example.com'), panel), 'rele');
		expect(v).toEqual({ ok: false, motivo: expect.stringContaining('publication key') });
	});

	it('una clave de otro uso (cloud, licencias) no basta', () => {
		const c = leerConfianza(`cloud:${publicacion.publica},licencias:${publicacion.publica}`, '');
		expect(verificarOrden(c, firmar(rele('rele.example.com')), 'rele').ok).toBe(false);
	});

	it('tocar el texto firmado la invalida', () => {
		const f = firmar(rele('rele.example.com'));
		const v = verificarOrden(
			publicacion.publica,
			{ ...f, orden: f.orden.replace('rele.example.com', 'malo.example.net') },
			'rele'
		);
		expect(v.ok).toBe(false);
	});

	it('una orden de recuperación no sirve como relé, ni al revés', () => {
		expect(verificarOrden(publicacion.publica, firmar(recuperacion), 'rele').ok).toBe(false);
		expect(verificarOrden(publicacion.publica, firmar(rele(null)), 'recuperacion').ok).toBe(false);
		expect(verificarOrden(publicacion.publica, firmar(recuperacion), 'recuperacion').ok).toBe(true);
	});

	it.each([
		['una dirección con esquema', { ...rele(null), direccion: 'https://x.example.com' }],
		['una IP como dirección', { ...rele(null), direccion: '10.0.0.1' }],
		['un usuario raro', { ...recuperacion, usuario: 'Admin; drop' }],
		['un hash raro', { ...recuperacion, codigoHash: 'plano' }],
		['un código de más de un día', { ...recuperacion, caduca: '2026-11-16T10:00:00.000Z' }],
		['un tipo desconocido', { ...recuperacion, tipo: 'borrar-todo' }]
	])('%s no vale aunque venga firmada', (_, o) => {
		const tipo = (o as Orden).tipo === 'rele' ? 'rele' : 'recuperacion';
		expect(verificarOrden(publicacion.publica, firmar(o), tipo).ok).toBe(false);
	});

	it('sin claves en las que confiar, nada vale', () => {
		expect(verificarOrden(leerConfianza('', ''), firmar(rele(null)), 'rele').ok).toBe(false);
	});

	it('el texto que se firma es el JSON de la orden', () =>
		expect(textoOrden(rele(null))).toBe(JSON.stringify(rele(null))));
});
