/*
 * Quién entra en este nodo. El flujo con Microsoft está en @sugardaddy/entra;
 * aquí solo se decide, con el token ya verificado. Hay dos formas:
 *
 * - Con el Entra de SeguridadSI (el .env, ENTRA_*): los usuarios de los
 *   clientes son invitados B2B en el tenant de SeguridadSI. Estar en el
 *   directorio no basta: hay que pertenecer al grupo de este cliente
 *   (ENTRA_GRUPO_CLIENTE), para que un invitado de un cliente no entre en el
 *   nodo de otro, y tener al menos un rol de la aplicación.
 * - Con el Entra propio del cliente (su tenant, configurado desde Ajustes,
 *   entra-propio.ts): ahí no hay grupo, porque el tenant ya es solo suyo; la
 *   aplicación exige asignación y basta con traer un rol. El soporte de
 *   SeguridadSI entra como invitado en ese tenant, con el rol `soporte`
 *   (identidadPropia; docs/diseno/identidad-clientes.md §2).
 *
 * El primero es el modelo de antes (B2B en el tenant de SeguridadSI). Ya no se
 * ofrece a clientes nuevos; los que lo tienen migran desde Ajustes (b2b.ts).
 */
import type { JWTPayload } from 'jose';
import { env } from '$env/dynamic/private';
import { correoDe, type Config } from '@sugardaddy/entra';
import { ROLES, type Rol } from './permisos';

export const COOKIE_OIDC = 'sd_oidc';

/* El Entra de SeguridadSI, si el .env lo trae. */
export function configuradoEnEntorno() {
	return !!(
		env.ENTRA_TENANT_ID &&
		env.ENTRA_CLIENT_ID &&
		env.ENTRA_CLIENT_SECRET &&
		env.ENTRA_GRUPO_CLIENTE
	);
}

export function configEntorno(): Config {
	if (!configuradoEnEntorno())
		throw new Error('Entra configuration is missing. Check the .env file.');
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
	rechazo:
		| 'sin_grupo'
		| 'demasiados_grupos'
		| 'sin_rol'
		| 'sin_correo'
		| 'sin_oid'
		| 'soporte_cerrado'
		| 'soporte_otro';
};

/* El rol de aplicación que el cliente asigna a la persona de soporte invitada en su tenant. */
export const ROL_SOPORTE = 'soporte';

const rolesDe = (p: JWTPayload) =>
	(Array.isArray(p.roles) ? p.roles : []).filter((r): r is Rol =>
		(ROLES as readonly unknown[]).includes(r)
	);

/* Si el cliente ha abierto el soporte: qué grupo de SeguridadSI entra y con qué rol. */
export type PuertaSoporte = { grupo: string; rol: Rol } | null;

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

	const roles = rolesDe(p);
	if (roles.length === 0) return { rechazo: 'sin_rol' };
	if (!correo) return { rechazo: 'sin_correo' };

	return { oid: p.oid, correo, nombre, roles, soporte: false };
}

/*
 * El soporte abierto, visto desde el Entra propio: quién lo pidió (firmado por
 * el panel), de qué tenant es SeguridadSI (también firmado) y el rol que eligió
 * el cliente. Nulo si el soporte no está abierto.
 */
export type PuertaInvitado = { correo: string; tenant: string | null; rol: Rol } | null;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* El claim `idp` de un invitado dice qué tenant le autenticó; tiene dos formas. */
export function idpEsTenant(idp: unknown, tenant: string | null) {
	if (typeof idp !== 'string' || !tenant || !GUID.test(tenant)) return false;
	const t = tenant.toLowerCase();
	const i = idp.toLowerCase().replace(/\/+$/, '');
	return (
		i === `https://sts.windows.net/${t}` || i === `https://login.microsoftonline.com/${t}/v2.0`
	);
}

/*
 * Con el Entra propio del cliente: quien llega ya es de su tenant (lo garantiza
 * el emisor del token) y la aplicación solo deja pasar a quien tiene asignado
 * un rol. Los roles valen lo mismo que en el Entra de SeguridadSI.
 *
 * Con el rol `soporte`, solo entra la persona de SeguridadSI que pidió el acceso,
 * como invitada (acct = 1), autenticada en el tenant de SeguridadSI (idp) y con
 * el soporte abierto; y entra con el rol que eligió el cliente, no con el del token.
 */
export function identidadPropia(p: JWTPayload, puerta: PuertaInvitado = null): Identidad | Rechazo {
	if (typeof p.oid !== 'string') return { rechazo: 'sin_oid' };
	const correo = correoDe(p);
	const nombre = typeof p.name === 'string' ? p.name : (correo ?? '');
	if (Array.isArray(p.roles) && p.roles.includes(ROL_SOPORTE)) {
		if (!puerta) return { rechazo: 'soporte_cerrado' };
		if (!correo) return { rechazo: 'sin_correo' };
		const invitado = p.acct === 1 || p.acct === '1';
		if (!invitado || correo !== puerta.correo.toLowerCase() || !idpEsTenant(p.idp, puerta.tenant))
			return { rechazo: 'soporte_otro' };
		return { oid: p.oid, correo, nombre, roles: [puerta.rol], soporte: true };
	}
	const roles = rolesDe(p);
	if (roles.length === 0) return { rechazo: 'sin_rol' };
	if (!correo) return { rechazo: 'sin_correo' };
	return { oid: p.oid, correo, nombre, roles, soporte: false };
}
