/*
 * «Probar» (docs/diseno/modulo-despliegue.md §8.3, paso 12), sin base de
 * datos: qué da «Probar» en cada trampa (comoProbar), de qué prueba es un
 * evento (pruebasDe) y cómo se comparan las IP. Lo mismo, por las rutas y la
 * entrega de eventos de verdad, en pruebas-base.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Evento, Honeycosa, PasosGenerados } from '@sugardaddy/contrato';

/* Sin base de datos: db no se conecta hasta la primera consulta, y aquí no hay ninguna. */
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/environment', () => ({ building: true, dev: true }));

const { leerHoneycosa, renderizar, validarParametros } = await import('@sugardaddy/contrato');
const p = await import('./pruebas');
type EstadoVisible = import('./colocacion').EstadoVisible;
type PruebaAbierta = import('./pruebas').PruebaAbierta;

const repo = join(process.cwd(), '../..');
const leer = (yaml: string): Honeycosa => {
	const r = leerHoneycosa(yaml);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
};
const cowrieYaml = readFileSync(join(repo, 'modulos/trampas/cowrie/trampa.yaml'), 'utf8');
const cowrie = leer(cowrieYaml);
/* Una copia de cowrie que solo escucha en UDP: sin prueba y sin puerto TCP. */
const soloUdp = leer(cowrieYaml.replaceAll('protocolo: tcp', 'protocolo: udp'));
const ejemplo = (n: string) =>
	readFileSync(join(repo, `paquetes/contrato/src/ejemplos/${n}`), 'utf8');
const smb = leer(ejemplo('smb.v2.yaml'));
const credencial = leer(ejemplo('credencial-ssh.v2.yaml'));

const estado = (e: EstadoVisible['estado']): EstadoVisible => ({
	estado: e,
	etiqueta: e,
	codigo: null,
	motivo: null,
	detalle: null,
	remedio: null,
	avisos: [],
	activa: e === 'comprobada'
});
const destino = (direccion: string | null = '10.40.0.5') => ({
	id: 'local',
	nombre: 'Sensor local',
	direccion
});
const parametros = (h: Honeycosa, v: Record<string, unknown> = {}) => {
	const r = validarParametros(h.parametros, v);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
};
const contenedor = { ejecutor: 'contenedor@1', via: 'contenedor', manual: null, senalTrampa: null };

/* Los pasos de una credencial en fs01 (Windows), con o sin la marca de su prueba. */
function pasosCredencial(h = credencial): PasosGenerados {
	const r = renderizar(
		h,
		'windows',
		parametros(h, { objetivo: 'cowrie-1', usuario: 'svc_sql4k7', sesion: 'nas42' }),
		{
			trampa: { id: 'cred-fs01', nombre: 'Credencial de fs01' },
			destino: { id: 'fs01', nombre: 'fs01', direccion: '10.40.0.77' },
			trampas: { 'cowrie-1': { direccion: '10.40.0.5', parametros: { puertoSsh: 2222 } } },
			generado: '2026-10-18T10:00:00.000Z'
		}
	);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
}
const manual = (m: PasosGenerados | null = pasosCredencial()) => ({
	ejecutor: 'manual@1',
	via: 'windows',
	manual: m,
	senalTrampa: 'cowrie-1'
});
const fs01 = (direccion: string | null = '10.40.0.77') => ({
	id: 'fs01',
	nombre: 'fs01',
	direccion
});

describe('comoProbar', () => {
	it('solo una trampa puesta (también degradada) se prueba; las demás dicen por qué', () => {
		const como = (e: EstadoVisible['estado'] | null, t: Parameters<typeof p.comoProbar>[0]) =>
			p.comoProbar(t, e && estado(e), cowrie, parametros(cowrie), destino());
		for (const e of ['colocada', 'comprobada', 'degradada'] as const)
			expect(como(e, contenedor).puede, e).toBe(true);
		expect(como('retirando', contenedor)).toEqual({
			puede: false,
			motivo: 'Se está retirando: ya no se prueba.'
		});
		expect(como('parada', contenedor)).toMatchObject({ motivo: /reanúdala/ });
		expect(como('sin-contacto', contenedor)).toMatchObject({ motivo: /no contesta/ });
		expect(como('por-colocar', contenedor)).toMatchObject({ motivo: /cuando su sensor la ponga/ });
		expect(como(null, contenedor)).toMatchObject({ puede: false });
		expect(p.comoProbar(manual(), estado('por-colocar'), credencial, {}, fs01())).toMatchObject({
			motivo: 'Primero ponla con sus pasos y pulsa «Ya está hecho».'
		});
	});

	it('sin prueba en su vía, la genérica: conectarse a un puerto TCP suyo, desde una IP que se pide', () => {
		expect(
			p.comoProbar(contenedor, estado('colocada'), cowrie, parametros(cowrie), destino())
		).toEqual({ puede: true, forma: 'generica', porIp: 'pedir', ip: null, ventanaMin: 15 });
	});

	it('sin la dirección de su destino, la genérica no se ofrece y dice por qué', () => {
		const sin = p.comoProbar(
			contenedor,
			estado('colocada'),
			cowrie,
			parametros(cowrie),
			destino(null)
		);
		expect(sin).toEqual({
			puede: false,
			motivo: 'Pon la dirección de Sensor local en Destinos para probarla.',
			destino: 'local'
		});
	});

	it('sin prueba ni puerto TCP, no se prueba: la comprobará el primer evento real', () => {
		expect(
			p.comoProbar(contenedor, estado('colocada'), soloUdp, parametros(soloUdp), destino())
		).toMatchObject({ puede: false, motivo: /ningún puerto TCP/ });
	});

	it('con la prueba de su vía: con marca no pide IP; sin la dirección que usan sus pasos, lo dice', () => {
		expect(p.comoProbar(contenedor, estado('colocada'), smb, parametros(smb), destino())).toEqual({
			puede: true,
			forma: 'via',
			porIp: null,
			ip: null,
			ventanaMin: 15
		});
		expect(
			p.comoProbar(contenedor, estado('colocada'), smb, parametros(smb), destino(null))
		).toMatchObject({ puede: false, motivo: /Pon la dirección de Sensor local/ });
	});

	it('sin su módulo o sin su vía, no se prueba', () => {
		expect(p.comoProbar(contenedor, estado('colocada'), undefined, {}, destino())).toMatchObject({
			motivo: /ya no está en el catálogo/
		});
		expect(
			p.comoProbar({ ...contenedor, via: 'otra' }, estado('colocada'), cowrie, {}, destino())
		).toMatchObject({ motivo: /ya no existe en su módulo/ });
	});

	it('una a mano se prueba desde su destino; con la marca de su prueba, sin IP', () => {
		expect(p.comoProbar(manual(), estado('colocada'), credencial, {}, fs01())).toEqual({
			puede: true,
			forma: 'destino',
			porIp: null,
			ip: null,
			ventanaMin: 15
		});
	});

	it('una a mano sin marca en su prueba cuenta lo que llegue desde su destino: hace falta su IP', () => {
		const m = pasosCredencial();
		const sinMarca = { ...m, prueba: { ...m.prueba!, marca: undefined } };
		expect(p.comoProbar(manual(sinMarca), estado('comprobada'), credencial, {}, fs01())).toEqual({
			puede: true,
			forma: 'destino',
			porIp: 'destino',
			ip: '10.40.0.77',
			ventanaMin: 15
		});
		expect(
			p.comoProbar(manual(sinMarca), estado('colocada'), credencial, {}, fs01('fs01.empresa.local'))
		).toMatchObject({ puede: false, motivo: /hace falta la IP de fs01, no su nombre/ });
		expect(
			p.comoProbar(manual(sinMarca), estado('colocada'), credencial, {}, fs01(null))
		).toMatchObject({ motivo: 'Pon la dirección de fs01 en Destinos para probarla.' });
	});

	it('una a mano sin prueba en su vía, o sin pasos, no se prueba', () => {
		const sinPrueba = { ...pasosCredencial(), prueba: undefined };
		expect(
			p.comoProbar(manual(sinPrueba), estado('colocada'), credencial, {}, fs01())
		).toMatchObject({ motivo: /no trae prueba/ });
		expect(p.comoProbar(manual(null), estado('colocada'), credencial, {}, fs01())).toMatchObject({
			motivo: /No tiene pasos guardados/
		});
	});
});

describe('pruebasDe', () => {
	const T = new Date('2026-10-18T10:00:00Z').getTime();
	const min = 60_000;
	const evento = (cambios: Partial<Evento> = {}): Evento => ({
		version: 2,
		id: '2b0e0000-0000-4000-8000-000000000001',
		/* El «cuando» del sensor no cuenta: aquí, desfasado un día. */
		cuando: new Date(T - 24 * 60 * min).toISOString(),
		trampa: { id: 'smb-1', modulo: 'smb', tipo: 'contenedor' },
		sensor: 'local',
		origen: { ip: '10.40.0.9', usuario: 'sdpruebaabcd1234' },
		accion: 'autenticacion',
		severidad: 'alta',
		conexionEstablecida: true,
		hashAnterior: '0'.repeat(64),
		...cambios
	});
	const abierta = (x: Partial<PruebaAbierta> = {}): PruebaAbierta => ({
		id: 'p1',
		trampa: 'smb-1',
		de: 'smb-1',
		senal: null,
		marca: { campo: 'origen.usuario', contiene: 'sdpruebaabcd1234' },
		ip: null,
		desde: new Date(T),
		hasta: new Date(T + 15 * min),
		evento: null,
		...x
	});
	const de = (e: Evento, cuando: number, a: PruebaAbierta[]) =>
		p.pruebasDe(e, new Date(cuando), a).map((x) => x.id);

	it('de su trampa, con su marca, recibido dentro de la ventana más 2 minutos', () => {
		const a = [abierta()];
		expect(de(evento(), T + 5 * min, a)).toEqual(['p1']);
		expect(de(evento(), T, a)).toEqual(['p1']);
		expect(de(evento(), T + 17 * min, a)).toEqual(['p1']);
		/* Fuera de la ventana, antes de abrirla o de otra trampa: no. */
		expect(de(evento(), T + 17 * min + 1, a)).toEqual([]);
		expect(de(evento(), T - 1, a)).toEqual([]);
		expect(de(evento({ trampa: { id: 'otra', modulo: 'smb', tipo: 'contenedor' } }), T, a)).toEqual(
			[]
		);
		/* Sin la marca, no. */
		expect(de(evento({ origen: { ip: '10.40.0.9', usuario: 'root' } }), T, a)).toEqual([]);
	});

	it('sin marca, desde la IP indicada (también escrita como IPv4 en IPv6)', () => {
		const a = [abierta({ marca: null, ip: '10.40.0.9' })];
		expect(de(evento({ origen: { ip: '10.40.0.9' } }), T, a)).toEqual(['p1']);
		expect(de(evento({ origen: { ip: '::ffff:10.40.0.9' } }), T, a)).toEqual(['p1']);
		expect(de(evento({ origen: { ip: '10.40.0.10' } }), T, a)).toEqual([]);
		expect(de(evento({ origen: {} }), T, a)).toEqual([]);
		expect(de(evento(), T, [abierta({ marca: null, ip: null })])).toEqual([]);
	});

	it('si su señal es otra trampa: un evento de esa otra que la active y cumpla la prueba', () => {
		const a = [
			abierta({
				id: 'p2',
				trampa: 'cred-fs01',
				de: 'cowrie-1',
				senal: { campo: 'origen.usuario', igual: 'svc_sql4k7' },
				marca: { campo: 'detalle.password', igual: 'sdpruebaabcd1234' }
			})
		];
		const cowrie = (usuario: string, password: string) =>
			evento({
				trampa: { id: 'cowrie-1', modulo: 'cowrie', tipo: 'contenedor' },
				origen: { ip: '10.40.0.77', usuario },
				detalle: { password }
			});
		expect(de(cowrie('SVC_SQL4K7', 'sdpruebaabcd1234'), T, a)).toEqual(['p2']);
		/* Con otro usuario no activa la credencial; con otra contraseña no es la prueba. */
		expect(de(cowrie('root', 'sdpruebaabcd1234'), T, a)).toEqual([]);
		expect(de(cowrie('svc_sql4k7', '123456'), T, a)).toEqual([]);
		/* Un evento «de» la propia credencial no existe: sus eventos son los de la Cowrie. */
		expect(
			de(evento({ trampa: { id: 'cred-fs01', modulo: 'x', tipo: 'identidad' } }), T, a)
		).toEqual([]);
		/* Sin objetivo (lo retiró una consola anterior), nada. */
		expect(de(cowrie('svc_sql4k7', 'sdpruebaabcd1234'), T, [{ ...a[0], de: null }])).toEqual([]);
	});
});

describe('IP y nonce', () => {
	it('normalizarIp: como las escribe el sensor; un nombre no es una IP', () => {
		expect(p.normalizarIp('::FFFF:10.0.0.5')).toBe('10.0.0.5');
		expect(p.normalizarIp(' 10.0.0.5 ')).toBe('10.0.0.5');
		expect(p.normalizarIp('[2001:DB8:0:0::1]')).toBe('2001:db8::1');
		expect(p.normalizarIp('2001:db8:0000::0001')).toBe('2001:db8::1');
		expect(p.normalizarIp('fs01')).toBeNull();
		expect(p.normalizarIp('')).toBeNull();
		expect(p.normalizarIp(null)).toBeNull();
	});

	it('nuevoNonce: 8 caracteres [a-z0-9], distintos cada vez', () => {
		const n = Array.from({ length: 50 }, () => p.nuevoNonce());
		for (const x of n) expect(x).toMatch(/^[a-z0-9]{8}$/);
		expect(new Set(n).size).toBe(50);
	});
});
