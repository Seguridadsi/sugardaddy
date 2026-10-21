/*
 * Lo que enseñan las páginas de Destinos y lo que se puede elegir en su
 * formulario corto (docs/diseno/modulo-despliegue.md §5.1 y §5.2). Lo usan
 * las páginas y el servidor, que vuelve a comprobar cada respuesta.
 */
import type { DescripcionDestino, Hecho, TipoDestino } from '@sugardaddy/contrato';

/* Los tipos que se pueden dar de alta, en el orden del desplegable: para elegir y para las listas. */
export const TIPOS_DESTINO: { valor: TipoDestino; texto: string; corto: string }[] = [
	{ valor: 'maquina', texto: 'Una máquina (servidor o puesto)', corto: 'Máquina' },
	{ valor: 'fileserver', texto: 'Un servidor de ficheros o un NAS', corto: 'Servidor de ficheros' },
	{ valor: 'web', texto: 'Una web en un servidor tuyo', corto: 'Web' },
	{ valor: 'paas-web', texto: 'Una web en la nube (App Service…)', corto: 'Web en la nube' },
	{ valor: 'hosting', texto: 'Una cuenta de hosting (cPanel, SFTP…)', corto: 'Hosting' },
	{ valor: 'dominio', texto: 'Un directorio activo', corto: 'Directorio activo' },
	{
		valor: 'tenant',
		texto: 'Una cuenta de nube (Microsoft 365, Azure, AWS, Google)',
		corto: 'Cuenta de nube'
	},
	{ valor: 'saas', texto: 'Otro servicio en la nube', corto: 'Servicio en la nube' },
	{ valor: 'otro', texto: 'Otra cosa', corto: 'Otro' }
];

export const nombreTipoDestino = (t: string) =>
	TIPOS_DESTINO.find((x) => x.valor === t)?.corto ?? t;

/*
 * Qué preguntas lleva el formulario de cada tipo (§5.2). Los tipos que en la
 * primera fase solo se pueden crear («solo otro corto») no preguntan nada
 * más que el nombre: el elector ya explica qué les falta.
 */
export type CampoDestino = keyof DescripcionDestino;
export const CAMPOS: Record<TipoDestino, CampoDestino[]> = {
	maquina: ['direccion', 'so', 'edicion', 'version', 'powershell', 'posix'],
	fileserver: ['direccion', 'so', 'version', 'powershell', 'posix', 'protocolos'],
	web: ['so'],
	'paas-web': [],
	hosting: [],
	dominio: [],
	tenant: [],
	saas: [],
	otro: ['so', 'nota']
};

export const camposDe = (tipo: string): CampoDestino[] =>
	Object.hasOwn(CAMPOS, tipo) ? CAMPOS[tipo as TipoDestino] : [];

type So = NonNullable<DescripcionDestino['so']>;

/* Los sistemas que se ofrecen en cada tipo; en un servidor de ficheros, con su nombre de allí. */
export function sistemasDe(tipo: string): { valor: So; texto: string }[] {
	if (tipo === 'fileserver')
		return [
			{ valor: 'windows', texto: 'Windows Server' },
			{ valor: 'linux', texto: 'Linux con Samba' },
			{ valor: 'nas', texto: 'NAS' }
		];
	return [
		{ valor: 'windows', texto: 'Windows' },
		{ valor: 'linux', texto: 'Linux' },
		{ valor: 'macos', texto: 'macOS' }
	];
}

export const nombreSo: Record<string, string> = {
	windows: 'Windows',
	linux: 'Linux',
	macos: 'macOS',
	nas: 'NAS'
};

export const EDICIONES: { valor: NonNullable<DescripcionDestino['edicion']>; texto: string }[] = [
	{ valor: 'servidor', texto: 'Servidor' },
	{ valor: 'puesto', texto: 'Puesto de trabajo' }
];

/*
 * Las versiones de Windows se eligen de una lista y se guardan con su número
 * (§4.2), que es lo que comparan los requisitos («minimo»). De Windows 10, la
 * 22H2, la única que sigue recibiendo parches; de Windows 11, la primera.
 */
export const VERSIONES_WINDOWS: {
	valor: string;
	texto: string;
	edicion: NonNullable<DescripcionDestino['edicion']>;
}[] = [
	{ valor: '10.0.14393', texto: 'Windows Server 2016', edicion: 'servidor' },
	{ valor: '10.0.17763', texto: 'Windows Server 2019', edicion: 'servidor' },
	{ valor: '10.0.20348', texto: 'Windows Server 2022', edicion: 'servidor' },
	{ valor: '10.0.26100', texto: 'Windows Server 2025', edicion: 'servidor' },
	{ valor: '10.0.19045', texto: 'Windows 10', edicion: 'puesto' },
	{ valor: '10.0.22000', texto: 'Windows 11', edicion: 'puesto' }
];

/* Las de un Windows de esa edición (en un servidor de ficheros, las de servidor); sin edición, todas. */
export function versionesWindows(tipo: string, edicion?: string) {
	const e = tipo === 'fileserver' ? 'servidor' : edicion;
	return VERSIONES_WINDOWS.filter((v) => !e || v.edicion === e);
}

/* PowerShell 7 se guarda como 7.0: lo menos que puede ser, que es lo que cuenta en un «minimo». */
export const POWERSHELL = [
	{ valor: '5.1', texto: 'PowerShell 5.1 (la de serie en Windows)' },
	{ valor: '7.0', texto: 'PowerShell 7 o posterior' }
];

export const POSIX: { valor: NonNullable<DescripcionDestino['posix']>; texto: string }[] = [
	{ valor: 'bash', texto: 'bash' },
	{ valor: 'sh', texto: 'sh (dash u otro)' },
	{ valor: 'busybox', texto: 'BusyBox' }
];

export const PROTOCOLOS: { valor: 'smb' | 'nfs'; texto: string }[] = [
	{ valor: 'smb', texto: 'SMB (carpetas de Windows)' },
	{ valor: 'nfs', texto: 'NFS' }
];

/* De cada campo del formulario, el hecho que da (§4.2): un campo cuyo hecho dice el sensor no se edita. */
export const HECHO_DE_CAMPO: Record<Exclude<CampoDestino, 'nota'>, string> = {
	so: 'plataforma.so',
	edicion: 'plataforma.edicion',
	version: 'plataforma.version',
	powershell: 'shell.powershell',
	posix: 'shell.posix',
	direccion: 'destino.direccion',
	protocolos: 'fileserver.protocolos'
};

export const nombreFuente: Record<NonNullable<Hecho['fuente']>, string> = {
	sensor: 'el sensor',
	consola: 'la consola',
	formulario: 'el formulario'
};

/*
 * La plataforma de un destino en pocas palabras, para las listas: la que dice
 * el sensor de su máquina («Ubuntu 24.04.1 LTS») o la del formulario
 * («Windows Server 2019», «Linux 22.04»). null si no se sabe.
 */
export function plataformaDe(hechos: Record<string, Hecho>): string | null {
	const valor = (k: string) => (Object.hasOwn(hechos, k) ? hechos[k]?.valor : undefined);
	const so = valor('plataforma.so');
	const sistema = valor('motor.sistema');
	if (hechos['plataforma.so']?.fuente === 'sensor' && typeof sistema === 'string' && sistema)
		return sistema;
	if (typeof so !== 'string') return null;
	const version = valor('plataforma.version');
	if (typeof version !== 'string') return nombreSo[so] ?? so;
	if (so === 'windows') {
		const w = VERSIONES_WINDOWS.find((x) => x.valor === version);
		if (w) return w.texto;
	}
	return `${nombreSo[so] ?? so} ${version}`;
}

/*
 * Los campos del formulario cuyo hecho ya dice el sensor del destino (§5.3):
 * esos no se editan. Con Docker Desktop o WSL el sensor no dice el sistema
 * (§4.3), y entonces se puede elegir.
 */
export function camposDelSensor(hechos: Record<string, Hecho>): Exclude<CampoDestino, 'nota'>[] {
	return (Object.keys(HECHO_DE_CAMPO) as Exclude<CampoDestino, 'nota'>[]).filter(
		(c) => Object.hasOwn(hechos, HECHO_DE_CAMPO[c]) && hechos[HECHO_DE_CAMPO[c]].fuente === 'sensor'
	);
}
