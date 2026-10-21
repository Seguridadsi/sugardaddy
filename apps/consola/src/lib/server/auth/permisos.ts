import { error } from '@sveltejs/kit';
import { puede, type Permiso } from '$lib/permisos';

export { ROLES, type Rol } from '$lib/permisos';

/* Para las acciones: un formulario no pasa por el `load`, así que cada acción se protege sola. */
export function exigir(locals: App.Locals, permiso: Permiso) {
	if (!locals.usuario) error(401, 'Hay que entrar primero');
	if (!puede(locals.usuario.roles, permiso)) error(403, 'Tu rol no permite esta acción');
	return locals.usuario;
}
