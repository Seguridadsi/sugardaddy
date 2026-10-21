import { describe, expect, it } from 'vitest';
import { cumpleMarca, type Evento, type Marca } from './index.ts';

/*
 * Cuándo un evento cumple una marca (docs/diseno/modulo-despliegue.md §2.4):
 * la de una prueba (§8.3) o la de lo sembrado (§8.5).
 */

const evento = (cambios: Partial<Evento> = {}): Evento => ({
	version: 2,
	id: '2b0e0000-0000-4000-8000-000000000001',
	cuando: '2026-10-18T10:00:00.000Z',
	trampa: { id: 'cowrie-1', modulo: 'cowrie', tipo: 'contenedor' },
	sensor: 'local',
	origen: { ip: '10.20.0.9', usuario: 'SVC_SQL4K7', equipo: 'PC-Nominas' },
	accion: 'autenticacion',
	severidad: 'alta',
	conexionEstablecida: true,
	detalle: { password: 'sdpruebaAB12cd34', intentos: 3, vacio: '', lista: ['x'] },
	hashAnterior: '0'.repeat(64),
	...cambios
});

describe('cumpleMarca', () => {
	it('igual: el mismo valor, sin distinguir mayúsculas', () => {
		const e = evento();
		expect(cumpleMarca(e, { campo: 'origen.usuario', igual: 'svc_sql4k7' })).toBe(true);
		expect(cumpleMarca(e, { campo: 'origen.usuario', igual: 'svc_sql4k' })).toBe(false);
		expect(cumpleMarca(e, { campo: 'origen.ip', igual: '10.20.0.9' })).toBe(true);
		expect(cumpleMarca(e, { campo: 'origen.ip', igual: '10.20.0.90' })).toBe(false);
		expect(cumpleMarca(e, { campo: 'origen.equipo', igual: 'pc-nominas' })).toBe(true);
	});

	it('contiene: el valor dentro del campo, sin distinguir mayúsculas', () => {
		const e = evento();
		expect(cumpleMarca(e, { campo: 'detalle.password', contiene: 'ab12CD34' })).toBe(true);
		expect(cumpleMarca(e, { campo: 'detalle.password', igual: 'sdpruebaab12cd34' })).toBe(true);
		expect(cumpleMarca(e, { campo: 'detalle.password', contiene: 'zz' })).toBe(false);
	});

	it('un número o un booleano del detalle se compara como texto', () => {
		expect(cumpleMarca(evento(), { campo: 'detalle.intentos', igual: '3' })).toBe(true);
	});

	it('sin el campo, con un campo que no es un valor simple o con la marca vacía, no cumple', () => {
		const e = evento({ origen: {} });
		for (const m of [
			{ campo: 'origen.usuario', igual: 'svc_sql4k7' },
			{ campo: 'origen.ip', contiene: '10' },
			{ campo: 'detalle.otro', contiene: 'x' },
			{ campo: 'detalle.lista', contiene: 'x' },
			{ campo: 'detalle.password', contiene: '' },
			{ campo: 'detalle.vacio', igual: '' },
			{ campo: 'detalle.toString', contiene: 'function' },
			{ campo: 'otro.campo', igual: 'x' }
		] as Marca[])
			expect(cumpleMarca(e, m), JSON.stringify(m)).toBe(false);
		expect(cumpleMarca(evento({ detalle: undefined }), { campo: 'detalle.x', igual: 'x' })).toBe(
			false
		);
	});
});
