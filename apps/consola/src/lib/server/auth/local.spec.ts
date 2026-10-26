/*
 * Las partes del login local que no tocan la base de datos: el hash de
 * contraseñas (scrypt), la validación del nombre de usuario, el reto del cambio
 * forzado y el interruptor del modo. La base y la auditoría se mockean para
 * poder importar el módulo.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('../db', () => ({ db: {}, schema: {} }));
vi.mock('../consultas', () => ({ auditar: async () => {} }));

const {
	abrirRetoCambio,
	cerrarRetoCambio,
	comprobarClave,
	hashClave,
	loginLocalHabilitado,
	retoCambio,
	usuarioValido
} = await import('./local');

describe('hash de contraseñas (scrypt)', () => {
	it('una contraseña verifica contra su propio hash y otra no', () => {
		const h = hashClave('frase larga y secreta');
		expect(comprobarClave('frase larga y secreta', h)).toBe(true);
		expect(comprobarClave('otra cosa', h)).toBe(false);
	});

	it('dos hashes de la misma contraseña son distintos (sal por usuario)', () => {
		expect(hashClave('misma')).not.toBe(hashClave('misma'));
	});

	it('usa el formato scrypt$32768$8$1$… (el que replica preparar-base.mjs)', () => {
		expect(hashClave('x')).toMatch(/^scrypt\$32768\$8\$1\$[^$]+\$[^$]+$/);
	});

	it('acepta un hash hecho con la MISMA fórmula que el sembrado del instalador', () => {
		/* Réplica exacta de hashClaveLocal() de scripts/preparar-base.mjs. */
		const sal = randomBytes(16);
		const h = scryptSync('clave del instalador', sal, 32, {
			N: 1 << 15,
			r: 8,
			p: 1,
			maxmem: 64 * 1024 * 1024
		});
		const almacenado = `scrypt$32768$8$1$${sal.toString('base64')}$${h.toString('base64')}`;
		expect(comprobarClave('clave del instalador', almacenado)).toBe(true);
	});

	it('un hash con formato inválido o manipulado no verifica (no revienta)', () => {
		expect(comprobarClave('x', '')).toBe(false);
		expect(comprobarClave('x', 'nada')).toBe(false);
		expect(comprobarClave('x', 'scrypt$32768$8$1$solo-cuatro-campos')).toBe(false);
		expect(comprobarClave('x', 'bcrypt$10$abc$def$ghi$jkl')).toBe(false);
		const h = hashClave('x');
		expect(comprobarClave('x', h.slice(0, -4) + 'AAAA')).toBe(false);
	});
});

describe('nombre de usuario', () => {
	it('acepta los razonables y rechaza los raros', () => {
		for (const ok of ['admin', 'ana.ruiz', 'op_1', 'a-b-c', 'juan99'])
			expect(usuarioValido(ok)).toBe(true);
		for (const mal of ['ab', '', '.ana', 'ana.', 'con espacio', 'a@b', 'a'.repeat(33), 'raro!'])
			expect(usuarioValido(mal)).toBe(false);
	});

	it('no distingue mayúsculas ni espacios al validar', () => {
		expect(usuarioValido('  Admin  ')).toBe(true);
	});
});

describe('reto del cambio forzado', () => {
	it('se lee una vez abierto y deja de valer al cerrarlo', () => {
		const reto = abrirRetoCambio('u-1');
		expect(retoCambio(reto)).toBe('u-1');
		expect(retoCambio(reto)).toBe('u-1'); // leer no lo gasta
		cerrarRetoCambio(reto);
		expect(retoCambio(reto)).toBeNull();
	});

	it('un reto desconocido o vacío no vale', () => {
		expect(retoCambio(undefined)).toBeNull();
		expect(retoCambio('inventado')).toBeNull();
	});
});

describe('interruptor del login local', () => {
	beforeEach(() => {
		delete env.LOGIN_LOCAL;
		delete env.EDICION;
	});

	it('se enciende con LOGIN_LOCAL=1 o con EDICION=community', () => {
		expect(loginLocalHabilitado()).toBe(false);
		env.LOGIN_LOCAL = '1';
		expect(loginLocalHabilitado()).toBe(true);
		env.LOGIN_LOCAL = '0';
		expect(loginLocalHabilitado()).toBe(false);
		env.EDICION = 'community';
		expect(loginLocalHabilitado()).toBe(true);
	});
});
