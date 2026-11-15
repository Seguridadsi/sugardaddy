/*
 * Lo que entra en el instalador del sensor remoto, que corre como root en otra
 * máquina (C03 de la auditoría 2026-11-14): la credencial que da el panel sin
 * firma, el .env y los valores que van en el texto del script.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
	ErrorCliente,
	comillasSimples,
	comprobarConsola,
	comprobarIdSensor,
	entornoDelSensor,
	validarDescarga
} from './script-sensor';

const BUENA = {
	registro: 'ghcr.io',
	usuario: 'cliente-1234-abcd',
	token: 'aB3+/xY9=='
};

describe('la credencial de descarga del panel', () => {
	it('acepta la del ACR, un registro con puerto y la de desarrollo sin contraseña', () => {
		expect(validarDescarga(BUENA)).toEqual(BUENA);
		expect(validarDescarga({ ...BUENA, registro: 'registro.local:5000' }).registro).toBe(
			'registro.local:5000'
		);
		expect(validarDescarga({ registro: 'registro.prueba', usuario: '', token: '' })).toEqual({
			registro: 'registro.prueba',
			usuario: '',
			token: ''
		});
	});

	it('se queda solo con sus tres campos', () => {
		expect(validarDescarga({ ...BUENA, otro: 'x' })).toEqual(BUENA);
	});

	const malas: [string, unknown][] = [
		['nada', null],
		['un texto', 'registro'],
		['un campo que no es texto', { ...BUENA, token: 1 }],
		['un usuario con comilla simple', { ...BUENA, usuario: "x'; id; echo '" }],
		['un usuario con espacio', { ...BUENA, usuario: 'a b' }],
		['un token con salto de línea', { ...BUENA, token: 'tok\nSENSOR_ID=otro' }],
		['un token con $()', { ...BUENA, token: 'tok$(id)' }],
		['un token con comilla', { ...BUENA, token: "tok'" }],
		['un token demasiado largo', { ...BUENA, token: 'a'.repeat(1025) }],
		['un registro con ruta', { ...BUENA, registro: 'r.io/otro' }],
		['un registro con metacaracteres', { ...BUENA, registro: "r.io'; id; '" }],
		['un registro vacío', { ...BUENA, registro: '' }],
		['usuario sin token', { ...BUENA, token: '' }],
		['token sin usuario', { ...BUENA, usuario: '' }]
	];
	for (const [que, d] of malas)
		it(`rechaza ${que}`, () => {
			expect(() => validarDescarga(d)).toThrow(ErrorCliente);
		});

	it('el mensaje de rechazo no lleva lo rechazado', () => {
		try {
			validarDescarga({ ...BUENA, usuario: "x'$(id)" });
		} catch (e) {
			expect((e as Error).message).not.toContain('$(id)');
		}
	});
});

describe('el .env del sensor', () => {
	it('une las líneas buenas', () => {
		expect(entornoDelSensor(['# comentario', 'A=1', 'B_2=x=y', 'VACIA='])).toBe(
			'# comentario\nA=1\nB_2=x=y\nVACIA='
		);
	});

	it('rechaza saltos de línea y otros caracteres de control en cualquier valor', () => {
		for (const v of ['a\nB=2', 'a\rb', 'a\0b', 'a\tb', 'a\u007fb'])
			expect(() => entornoDelSensor(['A=1', `X=${v}`])).toThrow(ErrorCliente);
	});

	it('rechaza líneas sin CLAVE= válida', () => {
		for (const l of ['sin igual', '=x', 'minus=1', '1A=x', 'A B=x'])
			expect(() => entornoDelSensor([l])).toThrow(ErrorCliente);
	});
});

describe('lo que va en el texto del script', () => {
	it('el id del sensor', () => {
		expect(() => comprobarIdSensor('sede-madrid-1')).not.toThrow();
		for (const id of ['', '-x', "a'b", 'a b', 'a$(id)', 'a;b'])
			expect(() => comprobarIdSensor(id)).toThrow(ErrorCliente);
	});

	it('la dirección de la consola y su nombre', () => {
		expect(() =>
			comprobarConsola('https://consola.cliente.test', 'consola.cliente.test')
		).not.toThrow();
		expect(() =>
			comprobarConsola('https://consola.cliente.test:8443', 'consola.cliente.test')
		).not.toThrow();
		expect(() => comprobarConsola('https://10.0.0.5', '10.0.0.5')).not.toThrow();
		expect(() => comprobarConsola('https://[2001:db8::1]', '[2001:db8::1]')).not.toThrow();
		/* new URL deja pasar estos nombres: aquí no. */
		for (const h of ["a'b.test", 'a$b.test', 'a;b', 'a`b`', 'a(b).test']) {
			const url = `https://${h}`;
			expect(() => comprobarConsola(url, new URL(url).hostname)).toThrow(ErrorCliente);
		}
		expect(() => comprobarConsola('https://c.test/x y', 'c.test')).toThrow(ErrorCliente);
	});

	it('comillasSimples da una sola palabra que bash no expande', () => {
		const texto = "it's $(id) `id` $HOME\nsecond";
		const salida = execFileSync('bash', ['-c', `printf %s ${comillasSimples(texto)}`], {
			encoding: 'utf8'
		});
		expect(salida).toBe("it's $(id) `id` $HOME second");
	});
});
