/*
 * puertosPublicados: qué puertos abre una trampa con unos parámetros (el mismo
 * cálculo que el sensor replica en Go). Función pura; todo en memoria.
 */
import { describe, expect, it } from 'vitest';
import type { ManifiestoTrampa } from './tipos.ts';
import { puertosPublicados } from './puertos.ts';

type Puertos = NonNullable<ManifiestoTrampa['contenedor']>['puertos'];
const m = (puertos: Puertos) =>
	({ contenedor: { imagen: 'x', puertos, registros: 'r' } }) as unknown as Pick<
		ManifiestoTrampa,
		'contenedor'
	>;
/* Un puerto paramétrico «${p}»; devuelve lo publicado para p = v. */
const param = (v: unknown) =>
	puertosPublicados(m([{ interno: 2222, expuesto: '${p}', protocolo: 'tcp' }] as Puertos), {
		p: v
	}).map((x) => x.puerto);

describe('puertosPublicados', () => {
	it('un expuesto numérico sale fijo, con interno y protocolo', () => {
		expect(
			puertosPublicados(m([{ interno: 2222, expuesto: 22, protocolo: 'tcp' }] as Puertos), {})
		).toEqual([{ puerto: 22, protocolo: 'tcp', fijo: true, interno: 2222 }]);
	});

	it('un expuesto paramétrico válido sale no-fijo con el valor del parámetro', () => {
		expect(
			puertosPublicados(m([{ interno: 9000, expuesto: '${p}', protocolo: 'udp' }] as Puertos), {
				p: 8080
			})
		).toEqual([{ puerto: 8080, protocolo: 'udp', fijo: false, interno: 9000 }]);
	});

	it('respeta los bordes del rango de puertos', () => {
		expect(param(65535)).toEqual([65535]);
		expect(param(65536)).toEqual([]);
		expect(param(1)).toEqual([1]);
		expect(param(0)).toEqual([]);
	});

	it('descarta valores del parámetro que no son un puerto', () => {
		expect(param(8080.5)).toEqual([]);
		expect(param('abc')).toEqual([]);
		expect(param('')).toEqual([]);
		expect(param(undefined)).toEqual([]);
		expect(param('8080')).toEqual([8080]); // una cadena numérica entera sí vale
	});

	it('«si»: solo se enciende con true / «yes» / «true»', () => {
		const con = (v: unknown) =>
			puertosPublicados(m([{ interno: 23, expuesto: 23, protocolo: 'tcp', si: 't' }] as Puertos), {
				t: v
			}).map((x) => x.puerto);
		expect(con(true)).toEqual([23]);
		expect(con('yes')).toEqual([23]);
		expect(con('true')).toEqual([23]);
		expect(con('no')).toEqual([]);
		expect(con(false)).toEqual([]);
		expect(con(undefined)).toEqual([]);
		expect(con(1)).toEqual([]);
	});

	it('sin contenedor (o sin puertos) da lista vacía', () => {
		expect(puertosPublicados({}, {})).toEqual([]);
		expect(puertosPublicados(m([] as Puertos), {})).toEqual([]);
	});

	it('una lista mixta conserva el orden y quita los apagados', () => {
		const puertos = [
			{ interno: 2222, expuesto: '${ssh}', protocolo: 'tcp' },
			{ interno: 23, expuesto: 23, protocolo: 'tcp', si: 'telnet' }
		] as Puertos;
		expect(puertosPublicados(m(puertos), { ssh: 22 }).map((x) => x.puerto)).toEqual([22]);
		expect(puertosPublicados(m(puertos), { ssh: 22, telnet: 'yes' })).toEqual([
			{ puerto: 22, protocolo: 'tcp', fijo: false, interno: 2222 },
			{ puerto: 23, protocolo: 'tcp', fijo: true, interno: 23 }
		]);
	});
});
