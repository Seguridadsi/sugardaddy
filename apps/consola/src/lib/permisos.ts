/*
 * Qué puede hacer cada rol. Los roles son app roles del registro de la
 * aplicación en Entra; el administrador de cada cliente los reparte entre sus
 * usuarios. `admin` lo puede todo. Esto se usa también en el navegador para
 * ocultar botones, pero quien decide es siempre el servidor (`exigir`).
 */

/*
 * De menos a más alcance (nombreRol y la migración de B2B se quedan con el último).
 * `credenciales` va el primero: se suma a otro rol, no es «más» que ninguno.
 */
export const ROLES = [
	'credenciales',
	'lector',
	'operador',
	'aprobador',
	'admin-listas',
	'admin'
] as const;
export type Rol = (typeof ROLES)[number];

export const PERMISOS = {
	ver: ['credenciales', 'lector', 'operador', 'aprobador', 'admin-listas', 'admin'],
	/*
	 * Revelar las credenciales que capturan las trampas (en todas partes salen
	 * enmascaradas) y buscar si se probó una contraseña. Cada vez queda en la
	 * auditoría (auditoria.credenciales). El rol `credenciales` se suma a otro.
	 */
	'ver-credenciales': ['credenciales'],
	desplegar: ['operador', 'admin'],
	aprobar: ['aprobador', 'admin'],
	listas: ['admin-listas', 'admin'],
	ajustes: ['admin']
} as const satisfies Record<string, readonly Rol[]>;

export type Permiso = keyof typeof PERMISOS;

/*
 * Separación de funciones del perfil bancario (lib/server/banca.ts): quien
 * administra la consola no revela credenciales capturadas, aunque tenga también
 * el rol `credenciales`. Se aplica a los roles de la sesión en cada petición.
 */
export const separarCredenciales = (roles: readonly string[]) =>
	roles.includes('admin') ? roles.filter((r) => r !== 'credenciales') : [...roles];

export const puede = (roles: readonly string[], permiso: Permiso) =>
	PERMISOS[permiso].some((r) => roles.includes(r));

/*
 * Si lo de un sensor o un honeypot sale por una salida de avisos (salidas_alcance)
 * se cambia desde la salida, con `ajustes`, y desde las fichas, con `desplegar`.
 * El mismo dato, con un solo criterio: dejar de enviar a un canal que configura
 * el administrador (el SIEM, el correo del cliente) es cosa suya; enviar o
 * heredar basta con `desplegar` (auditoría del 2026-11-14, h02).
 */
export const permisoDeAlcance = (envia: boolean | null | undefined): Permiso =>
	envia === false ? 'ajustes' : 'desplegar';

const NOMBRES_DE_ROL: Record<Rol, string> = {
	credenciales: 'Credential viewer',
	lector: 'Viewer',
	operador: 'Operator',
	aprobador: 'Approver',
	'admin-listas': 'List administrator',
	admin: 'Administrator'
};

/* El rol que se enseña: el de más alcance de los que tiene. */
export const nombreRol = (roles: readonly string[]) => {
	const rol = [...ROLES].reverse().find((r) => roles.includes(r));
	return rol ? NOMBRES_DE_ROL[rol] : (roles[0] ?? '');
};
