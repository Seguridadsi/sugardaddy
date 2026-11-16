import { describe, expect, it } from 'vitest';
import {
	direccionPanelValida,
	firmanteDePrivada,
	firmarCon,
	generarClaves,
	leerConfianza,
	motivoOrdenPanelAqui,
	textoOrden,
	verificarOrden,
	type Orden,
	type OrdenPanel
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

describe('la orden de la dirección del panel', () => {
	const viejo = 'sugardaddy-central.azurewebsites.net';
	const otra = generarClaves();
	const orden = (o: Partial<OrdenPanel> = {}): OrdenPanel => ({
		tipo: 'panel',
		version: 1,
		direccion: 'https://panel-dr.example.com',
		antes: [viejo],
		desde: '2026-11-15T00:00:00.000Z',
		caduca: '2026-12-15T00:00:00.000Z',
		emitida: '2026-11-15T00:00:00.000Z',
		...o
	});
	const ahora = Date.parse('2026-11-20T00:00:00.000Z');
	const c = leerConfianza(`delegaciones:${publicacion.publica}`, '');

	it('firmada con una clave de delegaciones, vale y se aplica al nodo de ese panel', () => {
		const v = verificarOrden(c, firmar(orden()), 'panel');
		expect(v).toEqual({ ok: true, orden: orden() });
		expect(motivoOrdenPanelAqui(orden(), `https://${viejo}`, ahora)).toBeNull();
		expect(motivoOrdenPanelAqui(orden(), `https://${viejo}/`, ahora)).toBeNull();
	});

	it('con la clave del panel, de cloud o de licencias, no vale', () => {
		expect(verificarOrden(c, firmar(orden(), panel), 'panel').ok).toBe(false);
		const otros = leerConfianza(
			`cloud:${publicacion.publica},licencias:${publicacion.publica}`,
			''
		);
		expect(verificarOrden(otros, firmar(orden()), 'panel').ok).toBe(false);
	});

	it('tocar la dirección o la ventana la invalida', () => {
		const f = firmar(orden());
		for (const [de, a] of [
			['panel-dr.example.com', 'malo.example.net'],
			['2026-12-15', '2027-12-15']
		])
			expect(verificarOrden(c, { ...f, orden: f.orden.replace(de, a) }, 'panel').ok).toBe(false);
	});

	it('antes de su ventana o caducada no se aplica', () => {
		expect(
			motivoOrdenPanelAqui(orden(), `https://${viejo}`, Date.parse('2026-11-14T00:00:00Z'))
		).toMatch(/not valid yet/);
		expect(
			motivoOrdenPanelAqui(orden(), `https://${viejo}`, Date.parse('2026-12-16T00:00:00Z'))
		).toMatch(/expired/);
	});

	it('un nodo de otro panel (la central de un MSP) no la sigue, ni el que ya está en la nueva', () => {
		expect(motivoOrdenPanelAqui(orden(), 'https://central.msp.example', ahora)).toMatch(/not for/);
		expect(motivoOrdenPanelAqui(orden(), 'https://panel-dr.example.com', ahora)).toMatch(
			/not for|already/
		);
	});

	it.each([
		['http', { direccion: 'http://panel-dr.example.com' }],
		['una IP', { direccion: 'https://10.0.0.1' }],
		['con ruta', { direccion: 'https://panel-dr.example.com/x' }],
		['con usuario', { direccion: 'https://a@panel-dr.example.com' }],
		['sin antes', { antes: [] }],
		['un antes con esquema', { antes: ['https://x.example.com'] }],
		['la nueva entre las de antes', { antes: ['panel-dr.example.com'] }],
		['caduca antes de empezar', { caduca: '2026-11-14T00:00:00.000Z' }],
		['de más de 90 días', { caduca: '2027-03-15T00:00:00.000Z' }],
		['unas claves del panel que no lo son', { clavesPanel: { claves: ['no-es-clave'] } }]
	])('%s no vale aunque venga firmada', (_, o) => {
		expect(verificarOrden(c, firmar(orden(o as Partial<OrdenPanel>)), 'panel').ok).toBe(false);
	});

	it('puede traer las claves del panel nuevo', () => {
		const o = orden({ clavesPanel: { claves: [otra.publica], reemplaza: ['0123456789abcdef'] } });
		expect(verificarOrden(c, firmar(o), 'panel').ok).toBe(true);
	});

	it('con puerto vale; una de relé no sirve como del panel', () => {
		expect(direccionPanelValida('https://panel.example.com:8443')).toBe(true);
		expect(direccionPanelValida('https://panel.example.com:0')).toBe(false);
		expect(verificarOrden(c, firmar(rele(null)), 'panel').ok).toBe(false);
	});
});
