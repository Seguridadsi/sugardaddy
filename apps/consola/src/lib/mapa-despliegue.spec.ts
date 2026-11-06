import { describe, expect, it } from 'vitest';
import {
	detalleNodo,
	enRed,
	enumerar,
	etiquetaTrampa,
	esPrivada,
	estadoEnPlural,
	filtrarMapa,
	ipPrincipal,
	leerDonde,
	tituloZona,
	type Mapa,
	type SensorMapa,
	type SistemaMapa,
	type TrampaMapa,
	type ZonaMapa
} from './mapa-despliegue';

const trampa = (c: Partial<TrampaMapa> = {}): TrampaMapa => ({
	id: 't',
	nombre: 'Trampa',
	modulo: null,
	clase: 'Contenedor',
	estado: 'comprobada',
	etiqueta: 'Comprobada',
	motivo: null,
	problema: false,
	eventos: 0,
	puertos: [],
	conIpPropia: false,
	ipPropia: null,
	ubicacion: null,
	ruta: null,
	recibeDe: [],
	objetivo: null,
	pictograma: null,
	procedencia: null,
	...c
});
const sensor = (c: Partial<SensorMapa> = {}): SensorMapa => ({
	id: 's',
	nombre: 'sd-nodo',
	ip: '10.20.0.15',
	otrasIps: [],
	local: true,
	vivo: true,
	ultimoLatido: null,
	plataforma: 'Ubuntu 24.04',
	motor: 'Docker 27',
	version: '0.22.0',
	entorno: 'Interno',
	ficha: null,
	avisos: [],
	trampas: [],
	sistemas: [],
	...c
});
const sistema = (c: Partial<SistemaMapa> = {}): SistemaMapa => ({
	id: 'd',
	nombre: 'FS01',
	tipo: 'Servidor de ficheros',
	icono: 'ficheros',
	direccion: '10.20.0.30',
	faltaDireccion: false,
	plataforma: null,
	ruta: null,
	linea: 'senal',
	trampas: [],
	...c
});
const zona = (c: Partial<ZonaMapa> = {}): ZonaMapa => ({
	clave: 'z',
	tipo: 'red',
	nombre: 'Servidores',
	red: '10.30.0.0/24',
	vlan: 30,
	entorno: 'Interno',
	sensores: [],
	sistemas: [],
	rele: false,
	...c
});
const mapa = (zonas: ZonaMapa[]): Mapa => ({
	consola: { ip: '10.20.0.15', equipo: 'sd-nodo', host: null, puerto: 443 },
	zonas,
	resumen: { sensores: 0, sensoresVivos: 0, sistemas: 0, trampas: 0, porEstado: {}, etiquetas: {} }
});

describe('direcciones', () => {
	it('enRed compara con la máscara del CIDR', () => {
		expect(enRed('10.20.0.15', '10.20.0.0/24')).toBe(true);
		expect(enRed('10.20.1.15', '10.20.0.0/24')).toBe(false);
		expect(enRed('10.20.1.15', '10.20.0.0/16')).toBe(true);
		expect(enRed('192.168.1.1', '192.168.1.1/32')).toBe(true);
		expect(enRed('1.2.3.4', '0.0.0.0/0')).toBe(true);
		/* Con el bit alto: el desplazamiento de JavaScript es con signo. */
		expect(enRed('200.1.1.1', '200.1.1.0/24')).toBe(true);
	});

	it('enRed no da por buena una dirección o un rango que no lo son', () => {
		expect(enRed('nas-02', '10.20.0.0/24')).toBe(false);
		expect(enRed('10.20.0.300', '10.20.0.0/24')).toBe(false);
		expect(enRed('10.20.0.1', 'x')).toBe(false);
		expect(enRed('10.20.0.1', '10.20.0.0/33')).toBe(false);
	});

	it('esPrivada solo con los rangos privados', () => {
		for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.0.1'])
			expect(esPrivada(ip), ip).toBe(true);
		for (const ip of ['172.32.0.1', '8.8.8.8', '203.0.113.24', 'servidor'])
			expect(esPrivada(ip), ip).toBe(false);
	});

	it('ipPrincipal prefiere la de su red, luego una privada y luego la primera', () => {
		expect(ipPrincipal(['192.168.1.5', '10.20.0.15'], '10.20.0.0/24')).toBe('10.20.0.15');
		expect(ipPrincipal(['8.8.8.8', '192.168.1.5'], null)).toBe('192.168.1.5');
		expect(ipPrincipal(['8.8.8.8', '192.168.1.5'], '10.0.0.0/8')).toBe('192.168.1.5');
		expect(ipPrincipal(['8.8.8.8'], null)).toBe('8.8.8.8');
		expect(ipPrincipal([], '10.0.0.0/8')).toBeNull();
	});

	it('leerDonde entiende lo que cuenta el sensor y nada más', () => {
		expect(leerDonde('0.0.0.0:22, 0.0.0.0:23')).toEqual({
			ipPropia: null,
			enlaces: [
				{ ip: '0.0.0.0', puerto: 22 },
				{ ip: '0.0.0.0', puerto: 23 }
			]
		});
		expect(leerDonde('IP propia 10.20.0.240')).toEqual({ ipPropia: '10.20.0.240', enlaces: [] });
		for (const otro of [
			'en espera: falta licencia',
			'error: x',
			'desplegando…',
			'pasos a mano',
			''
		])
			expect(leerDonde(otro), otro).toEqual({ ipPropia: null, enlaces: [] });
	});
});

describe('textos', () => {
	it('enumerar une y resume', () => {
		expect(enumerar([])).toBe('');
		expect(enumerar(['A'])).toBe('A');
		expect(enumerar(['A', 'B'])).toBe('A y B');
		expect(enumerar(['A', 'B', 'C'])).toBe('A, B y C');
		expect(enumerar(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C y 2 más');
	});

	it('estadoEnPlural concuerda con el número', () => {
		expect(estadoEnPlural('comprobada', 1)).toBe('comprobada');
		expect(estadoEnPlural('comprobada', 2)).toBe('comprobadas');
		expect(estadoEnPlural('comprobada', 0)).toBe('comprobadas');
		expect(estadoEnPlural('sin-contacto', 2)).toBe('sin contacto');
	});

	it('tituloZona usa el nombre, luego el rango y luego lo dice', () => {
		expect(tituloZona({ tipo: 'red', nombre: 'DMZ', red: '10.0.0.0/24' })).toBe('DMZ');
		expect(tituloZona({ tipo: 'red', nombre: null, red: '10.0.0.0/24' })).toBe('10.0.0.0/24');
		expect(tituloZona({ tipo: 'red', nombre: null, red: null })).toBe('Red sin indicar');
		expect(tituloZona({ tipo: 'fuera', nombre: null, red: null })).toBe('Fuera de tu red');
	});
});

describe('filtrarMapa', () => {
	const ssh = trampa({
		id: 'ssh',
		nombre: 'SSH y Telnet falsos',
		puertos: [{ servicio: 'SSH', puerto: '22/tcp', escuchaEn: null }]
	});
	const smb = trampa({
		id: 'smb',
		nombre: 'Carpeta compartida',
		estado: 'degradada',
		problema: true,
		puertos: [{ servicio: 'SMB', puerto: '445/tcp', escuchaEn: null }]
	});
	const keepass = trampa({
		id: 'kp',
		nombre: 'Base de KeePass cebo',
		ubicacion: 'D:\\IT\\claves.kdbx'
	});
	const fs = sistema({ trampas: [keepass] });
	const base = mapa([
		zona({ sensores: [sensor({ trampas: [ssh, smb], sistemas: [fs] })] }),
		zona({
			clave: 'dmz',
			nombre: 'DMZ',
			red: '172.16.10.0/24',
			vlan: 110,
			sensores: [sensor({ id: 'dmz', nombre: 'sd-dmz', ip: '172.16.10.5' })]
		})
	]);

	it('sin nada que filtrar devuelve lo mismo', () => {
		expect(filtrarMapa(base, '  ', false)).toBe(base);
	});

	it('por el puerto deja la trampa y el equipo, para que se siga viendo su IP', () => {
		const r = filtrarMapa(base, '445', false);
		expect(r.zonas).toHaveLength(1);
		expect(r.zonas[0].sensores[0].ip).toBe('10.20.0.15');
		expect(r.zonas[0].sensores[0].trampas.map((t) => t.id)).toEqual(['smb']);
		expect(r.zonas[0].sensores[0].sistemas).toEqual([]);
	});

	it('por la IP de un sensor deja todo lo suyo', () => {
		const r = filtrarMapa(base, '10.20.0.15', false);
		expect(r.zonas[0].sensores[0].trampas.map((t) => t.id)).toEqual(['ssh', 'smb']);
		expect(r.zonas[0].sensores[0].sistemas.map((x) => x.id)).toEqual(['d']);
	});

	it('por el nombre o el rango de una red deja la red entera', () => {
		expect(filtrarMapa(base, 'dmz', false).zonas.map((z) => z.clave)).toEqual(['dmz']);
		expect(filtrarMapa(base, '172.16.10', false).zonas.map((z) => z.clave)).toEqual(['dmz']);
		expect(filtrarMapa(base, 'vlan 110', false).zonas.map((z) => z.clave)).toEqual(['dmz']);
	});

	it('entra en lo que cuelga de un sensor sin perder su camino', () => {
		const r = filtrarMapa(base, 'claves.kdbx', false);
		expect(r.zonas[0].sensores[0].trampas).toEqual([]);
		expect(r.zonas[0].sensores[0].sistemas[0].trampas.map((t) => t.id)).toEqual(['kp']);
	});

	it('no distingue mayúsculas ni acentos', () => {
		expect(filtrarMapa(base, 'KEEPASS', false).zonas).toHaveLength(1);
		expect(
			filtrarMapa(
				mapa([zona({ nombre: 'Sede de Córdoba', sensores: [sensor()] })]),
				'cordoba',
				false
			).zonas
		).toHaveLength(1);
	});

	it('solo con problemas se queda con lo que los tiene', () => {
		const r = filtrarMapa(base, '', true);
		expect(r.zonas).toHaveLength(1);
		expect(r.zonas[0].sensores[0].trampas.map((t) => t.id)).toEqual(['smb']);
	});

	it('un sensor caído y un sistema sin IP son problemas aunque sus trampas no lo sean', () => {
		const caido = mapa([zona({ sensores: [sensor({ vivo: false, trampas: [ssh] })] })]);
		expect(filtrarMapa(caido, '', true).zonas[0].sensores).toHaveLength(1);
		const sinIp = mapa([
			zona({
				sensores: [sensor({ sistemas: [sistema({ direccion: null, faltaDireccion: true })] })]
			})
		]);
		expect(filtrarMapa(sinIp, '', true).zonas[0].sensores[0].sistemas).toHaveLength(1);
	});

	it('los dos filtros a la vez', () => {
		expect(filtrarMapa(base, 'smb', true).zonas[0].sensores[0].trampas).toHaveLength(1);
		expect(filtrarMapa(base, 'ssh', true).zonas).toEqual([]);
	});

	it('no cambia el resumen: sigue diciendo lo que hay', () => {
		const conResumen = { ...base, resumen: { ...base.resumen, trampas: 3 } };
		expect(filtrarMapa(conResumen, 'nada-de-esto', false).resumen.trampas).toBe(3);
		expect(filtrarMapa(conResumen, 'nada-de-esto', false).zonas).toEqual([]);
	});
});

describe('etiquetaTrampa', () => {
	const puerto = (servicio: string, p: string) => ({ servicio, puerto: p, escuchaEn: null });
	it('un puerto: su servicio y su puerto', () => {
		expect(etiquetaTrampa(trampa({ puertos: [puerto('SSH', '22/tcp')] }))).toEqual({
			arriba: 'SSH',
			abajo: '22/tcp',
			clase: 'puerto'
		});
	});
	it('varios por el mismo protocolo, juntos', () => {
		expect(
			etiquetaTrampa(trampa({ puertos: [puerto('SSH', '22/tcp'), puerto('Telnet', '23/tcp')] }))
		).toMatchObject({ arriba: 'SSH, Telnet', abajo: '22, 23/tcp' });
	});
	it('si no caben o van por protocolos distintos, el primero y cuántos más', () => {
		expect(
			etiquetaTrampa(
				trampa({
					puertos: [
						puerto('RTSP', '554/tcp'),
						puerto('WSD', '3702/udp'),
						puerto('mDNS', '5353/udp')
					]
				})
			)
		).toEqual({ arriba: 'RTSP, WSD +1', abajo: '554/tcp +2', clase: 'puerto' });
	});
	it('con IP propia enseña esa IP, y lo dice si aún no la tiene', () => {
		expect(etiquetaTrampa(trampa({ conIpPropia: true, ipPropia: '10.0.0.9' }))).toEqual({
			arriba: 'IP propia',
			abajo: '10.0.0.9',
			clase: 'propia'
		});
		expect(etiquetaTrampa(trampa({ conIpPropia: true })).abajo).toBe('Sin IP todavía');
	});
	it('sin puertos, su clase y su nombre', () => {
		expect(etiquetaTrampa(trampa({ clase: 'Fichero', nombre: 'KeePass' }))).toEqual({
			arriba: 'Fichero',
			abajo: 'KeePass',
			clase: 'nombre'
		});
	});
});

describe('detalleNodo', () => {
	const propia = trampa({ id: 'a', pictograma: 'web' });
	const fuera = trampa({ id: 'b' });
	const lejana = trampa({ id: 'c' });
	const fs = sistema({ id: 'fs', trampas: [fuera] });
	const nube = sistema({ id: 'nube', trampas: [lejana] });
	const s = sensor({ id: 'n', trampas: [propia], sistemas: [fs] });
	const base = mapa([
		zona({ sensores: [s] }),
		zona({ clave: 'fuera', tipo: 'fuera', sistemas: [nube] })
	]);

	it('encuentra cada clase de nodo', () => {
		expect(detalleNodo(base, 'c:n')).toMatchObject({ tipo: 'sensor', sensor: { id: 'n' } });
		expect(detalleNodo(base, 'c:zona:fuera')).toMatchObject({ tipo: 'puerta' });
		expect(detalleNodo(base, 's:fs')).toMatchObject({ tipo: 'sistema', recibe: { id: 'n' } });
		expect(detalleNodo(base, 's:nube')).toMatchObject({ tipo: 'sistema', recibe: null });
		expect(detalleNodo(base, 'f:c:n:web')).toMatchObject({ tipo: 'familia', nombre: 'Web' });
	});

	it('una trampa dice en qué equipo está y con qué IP', () => {
		expect(detalleNodo(base, 't:a')).toMatchObject({ equipo: 'sd-nodo', ip: '10.20.0.15' });
		expect(detalleNodo(base, 't:b')).toMatchObject({ equipo: 'FS01', ip: '10.20.0.30' });
		expect(detalleNodo(base, 't:c')).toMatchObject({ equipo: 'FS01' });
	});

	it('lo que ya no está no se encuentra', () => {
		expect(detalleNodo(base, 't:nada')).toBeNull();
	});
});
