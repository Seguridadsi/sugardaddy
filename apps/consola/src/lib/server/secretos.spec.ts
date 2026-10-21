/*
 * Los secretos de las salidas, cifrados con la clave del nodo: se leen con
 * la misma clave y para el mismo dueño, y con otra (o sin ninguna) se dice
 * por qué no, sin adivinar ni caer a texto en claro.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const entorno = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env: entorno }));

const { cifrar, claveDelNodo, descifrar, estadoClave, final, tapar } = await import('./secretos');

const CLAVE = 'a1'.repeat(32);

beforeEach(() => {
	entorno.CLAVE_SECRETOS = CLAVE;
});

describe('la clave del nodo', () => {
	it('son 64 caracteres hexadecimales; sin ella o mal formada, no hay', () => {
		expect(estadoClave()).toBe('lista');
		expect(claveDelNodo()?.bytes).toHaveLength(32);
		entorno.CLAVE_SECRETOS = '';
		expect(estadoClave()).toBe('falta');
		expect(claveDelNodo()).toBeNull();
		entorno.CLAVE_SECRETOS = 'corta';
		expect(estadoClave()).toBe('mal-formada');
		expect(claveDelNodo()).toBeNull();
	});

	it('su id no es la clave ni deja ver nada de ella', () => {
		const c = claveDelNodo()!;
		expect(c.id).toMatch(/^[0-9a-f]{16}$/);
		expect(CLAVE).not.toContain(c.id);
	});
});

describe('cifrar y descifrar', () => {
	it('se lee con la misma clave y el mismo dueño', () => {
		const sobre = cifrar({ token: 'secreto-de-verdad-123' }, 'salida:1');
		expect(sobre).not.toContain('secreto-de-verdad');
		expect(descifrar(sobre, 'salida:1')).toEqual({
			ok: true,
			valores: { token: 'secreto-de-verdad-123' }
		});
	});

	it('cada vez sale distinto (IV nuevo)', () => {
		expect(cifrar({ a: 'x' }, 'salida:1')).not.toBe(cifrar({ a: 'x' }, 'salida:1'));
	});

	it('ligado a su dueño: copiado a otra salida no se lee', () => {
		const sobre = cifrar({ token: 't' }, 'salida:1');
		expect(descifrar(sobre, 'salida:2')).toEqual({ ok: false, motivo: 'ilegible' });
	});

	it('con otra clave del nodo dice que es otra, y sin clave, que falta', () => {
		const sobre = cifrar({ token: 't' }, 'salida:1');
		entorno.CLAVE_SECRETOS = randomBytes(32).toString('hex');
		expect(descifrar(sobre, 'salida:1')).toEqual({ ok: false, motivo: 'otra-clave' });
		entorno.CLAVE_SECRETOS = '';
		expect(descifrar(sobre, 'salida:1')).toEqual({ ok: false, motivo: 'sin-clave' });
		expect(() => cifrar({ token: 't' }, 'salida:1')).toThrow(/CLAVE_SECRETOS/);
	});

	it('tocado en la base de datos, no se lee (GCM autentica)', () => {
		const sobre = cifrar({ token: 'abcdef' }, 'salida:1');
		const partes = sobre.split('.');
		const datos = Buffer.from(partes[3], 'base64url');
		datos[0] ^= 1;
		partes[3] = datos.toString('base64url');
		expect(descifrar(partes.join('.'), 'salida:1')).toEqual({ ok: false, motivo: 'ilegible' });
		/* Haciéndose pasar por otra clave tampoco sirve. */
		const otra = sobre.split('.');
		otra[1] = '0'.repeat(16);
		expect(descifrar(otra.join('.'), 'salida:1')).toEqual({ ok: false, motivo: 'otra-clave' });
		expect(descifrar('basura', 'salida:1')).toEqual({ ok: false, motivo: 'ilegible' });
	});
});

describe('lo que se enseña de un secreto', () => {
	it('sus 4 últimos caracteres, solo si es largo', () => {
		expect(final('xoxb-1234567890-abcd')).toBe('abcd');
		expect(final('corto')).toBeNull();
	});

	it('un error que lo repite sale tapado, también como va en una URL', () => {
		const s = 'https://hooks.example/abc def/123';
		const e = `fallo al llamar a ${s} y a ${encodeURIComponent(s)}`;
		expect(tapar(e, [s])).toBe('fallo al llamar a •••• y a ••••');
		expect(tapar('nada que tapar', ['abc'])).toBe('nada que tapar');
	});

	it('también a trozos: el token de «Bearer …», la firma de una URL de Teams, el token de Slack', () => {
		const bearer = 'Bearer tk_ZZZ9f8e7d6c5b4a3';
		expect(tapar('401 {"error":"invalid token tk_ZZZ9f8e7d6c5b4a3"}', [bearer])).toBe(
			'401 {"error":"invalid token ••••"}'
		);
		const teams =
			'https://prod-01.westeurope.logic.azure.com:443/workflows/0a1b2c3d4e5f60718293a4b5c6d7e8f9/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd';
		expect(
			tapar(
				'firma AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd mala para el flujo 0a1b2c3d4e5f60718293a4b5c6d7e8f9 en workflows/triggers',
				[teams]
			)
		).toBe('firma •••• mala para el flujo •••• en workflows/triggers');
		const slack = 'https://hooks.slack.com/services/T0123ABCD/B0456EFGH/XyZ123abcDEF456ghiJKL789';
		expect(tapar('no_team T0123ABCD; token XyZ123abcDEF456ghiJKL789 en services', [slack])).toBe(
			'no_team ••••; token •••• en services'
		);
		/* Lo que no parece secreto se queda: el esquema, las palabras de la ruta, el servidor. */
		expect(tapar('Bearer rechazado en hooks.slack.com', [bearer, slack])).toBe(
			'Bearer rechazado en hooks.slack.com'
		);
	});
});
