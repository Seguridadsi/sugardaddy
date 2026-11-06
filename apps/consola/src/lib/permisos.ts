/*
 * Qué puede hacer cada rol. Los roles son app roles del registro de la
 * aplicación en Entra; el administrador de cada cliente los reparte entre sus
 * usuarios. `admin` lo puede todo. Esto se usa también en el navegador para
 * ocultar botones, pero quien decide es siempre el servidor (`exigir`).
 */

export const ROLES = ['lector', 'operador', 'aprobador', 'admin-listas', 'admin'] as const;
export type Rol = (typeof ROLES)[number];

export const PERMISOS = {
	ver: ['lector', 'operador', 'aprobador', 'admin-listas', 'admin'],
	desplegar: ['operador', 'admin'],
	aprobar: ['aprobador', 'admin'],
	listas: ['admin-listas', 'admin'],
	ajustes: ['admin']
} as const satisfies Record<string, readonly Rol[]>;

export type Permiso = keyof typeof PERMISOS;

export const puede = (roles: readonly string[], permiso: Permiso) =>
	PERMISOS[permiso].some((r) => roles.includes(r));

const NOMBRES_DE_ROL: Record<Rol, string> = {
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
