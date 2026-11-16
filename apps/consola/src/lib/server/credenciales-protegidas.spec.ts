/*
 * Las credenciales capturadas (B-09): la línea se guarda enmascarada, el valor va
 * en un sobre ligado al hash del evento, la huella agrupa sin descifrar, y sin
 * clave no queda nada en claro.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const entorno = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env: entorno }));

const { abrir, huella, mascara, proteger, restaurar, OCULTO, esCampoCredencial, enmascararLinea } =
	await import('./credenciales-protegidas');
const { claveDelNodo } = await import('./secretos');

const CLAVE = 'b2'.repeat(32);
const HASH = 'c3'.repeat(32);

const linea = (detalle: Record<string, unknown>) =>
	JSON.stringify({
		version: 2,
		id: '6f1c2b1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
		trampa: { id: 'ssh-1', modulo: 'cowrie', tipo: 'contenedor' },
		origen: { ip: '203.0.113.9', usuario: 'root' },
		accion: 'autenticacion',
		severidad: 'alta',
		hashAnterior: '0'.repeat(64),
		detalle
	});

beforeEach(() => {
	entorno.CLAVE_SECRETOS = CLAVE;
});

describe('la máscara', () => {
	it('larga: primera y dos últimas; corta: todo tapado; nunca el valor', () => {
		expect(mascara('Primavera2026')).toBe('P**********26');
		expect(mascara('toor')).toBe('****');
		expect(mascara('')).toBe('');
		const larga = 'a'.repeat(60) + 'XY';
		expect(mascara(larga)).toBe(`a${'*'.repeat(12)}…XY`);
	});
});

describe('qué campos son credencial', () => {
	it('la lista cerrada y el que declara el traductor; hash a secas y clave no', () => {
		expect(esCampoCredencial('password')).toBe(true);
		expect(esCampoCredencial('ntlm_hash')).toBe(true);
		expect(esCampoCredencial('hash')).toBe(false);
		expect(esCampoCredencial('clave')).toBe(false);
		expect(esCampoCredencial('hash', 'hash')).toBe(true);
	});
});

describe('proteger una línea', () => {
	it('enmascara en la línea y guarda el valor en un sobre que se abre con su hash', () => {
		const l = linea({
			password: 'Primavera2026',
			ntlm_hash: 'aabbccddeeff00112233',
			comando: 'ls'
		});
		const p = proteger(l, HASH, 'password');
		expect(p.protegida).toBe(true);
		expect(p.perdida).toBe(false);
		expect(p.linea).not.toContain('Primavera2026');
		expect(p.linea).not.toContain('aabbccddeeff00112233');
		expect(p.credencial).not.toContain('Primavera2026');
		const d = JSON.parse(p.linea);
		expect(d.detalle.password).toBe('P**********26');
		expect(d.detalle.comando).toBe('ls');
		/* El resto de la línea, igual (el hashAnterior de la cadena del sensor, también). */
		expect(d.hashAnterior).toBe('0'.repeat(64));
		expect(p.contrasenaMascara).toBe('P**********26');
		expect(p.contrasenaHuella).toBe(huella('Primavera2026'));
		const a = abrir(p.credencial!, HASH);
		expect(a).toEqual({
			ok: true,
			credencial: {
				contrasena: 'Primavera2026',
				detalle: { password: 'Primavera2026', ntlm_hash: 'aabbccddeeff00112233' }
			}
		});
	});

	it('el sobre no sirve en otra fila (otro hash) ni con otra clave', () => {
		const p = proteger(linea({ password: 'Primavera2026' }), HASH, 'password');
		expect(abrir(p.credencial!, 'd4'.repeat(32)).ok).toBe(false);
		entorno.CLAVE_SECRETOS = 'e5'.repeat(32);
		expect(abrir(p.credencial!, HASH)).toEqual({ ok: false, motivo: 'otra-clave' });
	});

	it('sin nada que proteger, la línea se queda letra por letra como llegó', () => {
		const l = linea({ comando: 'uname -a', usando_password: true, hash: 'f'.repeat(64) });
		const p = proteger(l, HASH, 'password');
		expect(p).toMatchObject({ linea: l, credencial: null, protegida: false });
	});

	it('lo que no es texto (una lista) va entero al sobre y en la línea pone [encrypted]', () => {
		const p = proteger(linea({ credencial: ['a', 'b'] }), HASH, undefined);
		expect(JSON.parse(p.linea).detalle.credencial).toBe(OCULTO);
		expect(p.contrasenaHuella).toBeNull();
		const a = abrir(p.credencial!, HASH);
		expect(a.ok && a.credencial.detalle.credencial).toEqual(['a', 'b']);
	});

	it('una fila de antes con la columna puesta y sin el campo en la línea también se cifra', () => {
		const p = proteger(linea({}), HASH, 'password', 'Vieja-123');
		expect(p.protegida).toBe(true);
		const a = abrir(p.credencial!, HASH);
		expect(a.ok && a.credencial.contrasena).toBe('Vieja-123');
	});

	it('sin clave en el nodo no queda nada en claro: máscara y sobre vacío', () => {
		entorno.CLAVE_SECRETOS = '';
		expect(claveDelNodo()).toBeNull();
		const p = proteger(linea({ password: 'Primavera2026' }), HASH, 'password');
		expect(p.perdida).toBe(true);
		expect(p.credencial).toBe('');
		expect(p.contrasenaHuella).toBeNull();
		expect(p.linea).not.toContain('Primavera2026');
	});

	it('la huella es la misma para la misma contraseña y depende de la clave', () => {
		const a = huella('Primavera2026');
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(huella('Primavera2026')).toBe(a);
		entorno.CLAVE_SECRETOS = 'e5'.repeat(32);
		expect(huella('Primavera2026')).not.toBe(a);
	});

	it('restaurar devuelve los valores al detalle (para una salida que los pide completos)', () => {
		const p = proteger(linea({ password: 'Primavera2026', comando: 'id' }), HASH, 'password');
		const e = JSON.parse(p.linea);
		const a = abrir(p.credencial!, HASH);
		if (!a.ok) throw new Error('no abre');
		expect(restaurar(e, a.credencial).detalle).toEqual({
			password: 'Primavera2026',
			comando: 'id'
		});
	});
});

describe('enmascararLinea: la cuarentena y las filas antiguas', () => {
	it('enmascara el detalle por la lista cerrada y deja lo demás', () => {
		const l = linea({
			password: 'Primavera2026',
			hash: 'abcdef0123',
			ntlm_hash: ['x'],
			usuario: 'root'
		});
		const d = JSON.parse(enmascararLinea(l)).detalle;
		expect(d.password).toBe(mascara('Primavera2026'));
		expect(d.ntlm_hash).toBe(OCULTO);
		expect(d.hash).toBe('abcdef0123');
		expect(d.usuario).toBe('root');
	});

	it('los campos que declaran los traductores y el valor de la columna vieja', () => {
		const l = linea({ pass_ftp: 'Secreto-Ftp-1', otro: 'Vieja-Columna-2' });
		const d = JSON.parse(enmascararLinea(l, ['pass_ftp'], 'Vieja-Columna-2')).detalle;
		expect(d.pass_ftp).toBe(mascara('Secreto-Ftp-1'));
		expect(d.otro).toBe(mascara('Vieja-Columna-2'));
	});

	it('una línea que no es JSON o va cortada, por texto', () => {
		const cortada = '{"detalle":{"password":"Primavera2026","token":"abcdefghijkl';
		const r = enmascararLinea(cortada);
		expect(r).not.toContain('Primavera2026');
		expect(r).not.toContain('abcdefghijkl');
		expect(r).toContain(mascara('Primavera2026'));
		expect(enmascararLinea('basura sin credenciales')).toBe('basura sin credenciales');
	});

	it('es idempotente', () => {
		const l = linea({ password: 'Primavera2026-con-mas-de-doce', token: { a: 1 } });
		const una = enmascararLinea(l);
		expect(enmascararLinea(una)).toBe(una);
		expect(JSON.parse(una).detalle.token).toBe(OCULTO);
	});
});

describe('el token de una baliza', () => {
	it('se queda a la vista: es nuestro, no del atacante; el de otra acción se tapa', () => {
		const deBaliza = JSON.stringify({
			...JSON.parse(linea({ token: 'tk-pixel-prueba', password: 'Primavera2026' })),
			accion: 'baliza'
		});
		const tapada = JSON.parse(enmascararLinea(deBaliza));
		expect(tapada.detalle.token).toBe('tk-pixel-prueba');
		expect(tapada.detalle.password).toBe('P**********26');
		const p = proteger(deBaliza, HASH, null);
		expect(JSON.parse(p.linea).detalle.token).toBe('tk-pixel-prueba');
		expect(JSON.parse(enmascararLinea(linea({ token: 'tk-pixel-prueba' }))).detalle.token).not.toBe(
			'tk-pixel-prueba'
		);
	});
});
