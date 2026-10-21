/*
 * Quién entra en este nodo. El flujo con Microsoft está en @sugardaddy/entra;
 * aquí solo se decide, con el token ya verificado.
 *
 * Los usuarios de los clientes son invitados B2B en el tenant de SeguridadSI.
 * Estar en el directorio no basta para entrar en este nodo:
 *
 * - hay que pertenecer al grupo de este cliente (ENTRA_GRUPO_CLIENTE), para
 *   que un invitado de un cliente no entre en el nodo de otro;
 * - y hay que tener al menos un rol de la aplicación.
 */
import type { JWTPayload } from 'jose';
import { env } from '$env/dynamic/private';
import { canjear, correoDe, type Config } from '@sugardaddy/entra';
import { ROLES, type Rol } from './permisos';

export const COOKIE_OIDC = 'sd_oidc';

export function configurado() {
	return !!(
		env.ENTRA_TENANT_ID &&
		env.ENTRA_CLIENT_ID &&
		env.ENTRA_CLIENT_SECRET &&
		env.ENTRA_GRUPO_CLIENTE
	);
}

export function config(): Config {
	if (!configurado()) throw new Error('Falta la configuración de Entra. Revisa el .env.');
	return {
		tenant: env.ENTRA_TENANT_ID!,
		clientId: env.ENTRA_CLIENT_ID!,
		secret: env.ENTRA_CLIENT_SECRET!
	};
}

export type Identidad = {
	oid: string;
	correo: string;
	nombre: string;
	roles: Rol[];
	soporte: boolean;
};

export type Rechazo = {
	rechazo: 'sin_grupo' | 'demasiados_grupos' | 'sin_rol' | 'sin_correo' | 'sin_oid';
};

/* Si el cliente ha abierto el soporte: qué grupo de SeguridadSI entra y con qué rol. */
export type PuertaSoporte = { grupo: string; rol: Rol } | null;

export async function canjearCodigo(o: Parameters<typeof canjear>[1], soporte: PuertaSoporte) {
	return identidadDesdePayload(await canjear(config(), o), env.ENTRA_GRUPO_CLIENTE!, soporte);
}

/* Separado para poder probarlo sin firmar tokens. */
export function identidadDesdePayload(
	p: JWTPayload,
	grupo: string,
	soporte: PuertaSoporte = null
): Identidad | Rechazo {
	if (typeof p.oid !== 'string') return { rechazo: 'sin_oid' };

	/*
	 * Con muchos grupos, Entra no los manda y pone una referencia a Graph en su
	 * lugar. No se intenta resolver: un invitado no debería estar en tantos, y
	 * si pasa es mejor enterarse que dejarle entrar a ciegas.
	 */
	const nombres = p._claim_names as Record<string, unknown> | undefined;
	if (nombres?.groups) return { rechazo: 'demasiados_grupos' };
	const grupos = Array.isArray(p.groups) ? p.groups : [];
	const correo = correoDe(p);
	const nombre = typeof p.name === 'string' ? p.name : (correo ?? '');

	if (!grupos.includes(grupo)) {
		/*
		 * Personal de SeguridadSI: solo con el soporte abierto por el cliente, y
		 * con el rol que él eligió, no con el que traiga el token.
		 */
		if (soporte && grupos.includes(soporte.grupo)) {
			if (!correo) return { rechazo: 'sin_correo' };
			return { oid: p.oid, correo, nombre, roles: [soporte.rol], soporte: true };
		}
		return { rechazo: 'sin_grupo' };
	}

	const roles = (Array.isArray(p.roles) ? p.roles : []).filter((r): r is Rol =>
		(ROLES as readonly unknown[]).includes(r)
	);
	if (roles.length === 0) return { rechazo: 'sin_rol' };
	if (!correo) return { rechazo: 'sin_correo' };

	return { oid: p.oid, correo, nombre, roles, soporte: false };
}
