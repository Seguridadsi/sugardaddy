/*
 * Entrar con el proveedor de identidad DEL CLIENTE por OpenID Connect: Okta,
 * Ping, ADFS, Keycloak, Auth0, Google Workspace… (plan de fortificación §4.2).
 * Misma forma que el Entra propio (entra-propio.ts): se guarda en la tabla de
 * ajustes con el secreto cifrado con la clave del nodo, queda PENDIENTE y solo
 * se activa cuando un administrador hace una entrada de prueba y vuelve con el
 * rol admin. Así un dato mal copiado no deja a nadie fuera; el login local, el
 * Entra propio y la entrada de emergencia siguen ahí.
 *
 * Los roles los da el proveedor: una «claim» del token (de serie `groups`) y,
 * para cada rol de Sugardaddy, qué valores de esa claim lo dan. Sin ninguno, no
 * se entra.
 *
 * MFA: de serie se exige que el token diga que la hubo (amr con «mfa» o con dos
 * métodos de tipo distinto, o un acr de la lista). Si el proveedor no lo dice,
 * se rechaza con un mensaje que explica qué hay que configurar allí. Se puede
 * apagar, y queda en la auditoría.
 *
 * SAML 2.0 todavía no: ver docs/diseno/auth-login.md (siguiente paso).
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { JWTPayload } from 'jose';
import {
	correoOidc,
	descubrir,
	huboMfa,
	urlSegura,
	valoresClaim,
	type ConfigOidc
} from '@sugardaddy/entra/oidc';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { cifrar, descifrar, estadoClave, final } from '../secretos';
import { retiradaB2B } from './b2b';
import { configuradoEnEntorno, type Identidad } from './entra';
import { ROLES, type Rol } from './permisos';
import { loginLocalHabilitado } from './local';

/* Lo lee también entra-propio.ts (sin importar este módulo): si cambia aquí, allí. */
export const AJUSTE_OIDC = 'oidc_propio';
const CONTEXTO = 'oidc-propio';
export const COOKIE_OIDC_PROPIO = 'sd_oidc_propio';

export type MapaRoles = Partial<Record<Rol, string[]>>;

type Guardado = {
	emisor: string;
	clientId: string;
	secreto: string;
	final: string | null;
	/* El texto del botón: «Sign in with …». */
	nombre: string;
	alcances: string;
	claim: string;
	roles: MapaRoles;
	exigirMfa: boolean;
	acr: string[];
	activo: boolean;
	guardadoPor: string;
	guardado: string;
	activadoPor?: string;
	activado?: string;
};

async function leer(): Promise<Guardado | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_OIDC));
	return (f?.valor as Guardado | undefined) ?? null;
}

async function escribir(v: Guardado) {
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE_OIDC, valor: v })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: v } });
}

/* Lo que se puede enseñar en Ajustes: todo menos el secreto. */
export async function estadoOidc() {
	const g = await leer();
	if (!g) return null;
	const { secreto, ...resto } = g;
	return { ...resto, legible: descifrar(secreto, CONTEXTO).ok };
}

export type Oidc = { config: ConfigOidc; guardado: Omit<Guardado, 'secreto'> };

/* La configuración, esté activa o pendiente de probar. */
export async function configOidc(): Promise<Oidc | null> {
	const g = await leer();
	if (!g) return null;
	const d = descifrar(g.secreto, CONTEXTO);
	if (!d.ok) return null;
	const { secreto, ...guardado } = g;
	void secreto;
	return {
		config: {
			emisor: g.emisor,
			clientId: g.clientId,
			secret: d.valores.secreto,
			alcances: g.alcances,
			acr: g.acr
		},
		guardado
	};
}

/* La activa, si la hay: la que sale en la pantalla de entrada. */
export async function oidcActivo(): Promise<Oidc | null> {
	const c = await configOidc();
	return c?.guardado.activo ? c : null;
}

/* Valores separados por comas o saltos de línea, sin repetidos ni vacíos. */
export const lista = (t: string) => [
	...new Set(
		t
			.split(/[\n,]+/)
			.map((x) => x.trim())
			.filter(Boolean)
	)
];

export type DatosOidc = {
	emisor: string;
	clientId: string;
	secreto: string;
	nombre: string;
	alcances: string;
	claim: string;
	roles: Record<string, string>;
	exigirMfa: boolean;
	acr: string;
};

const CLAIM = /^[A-Za-z0-9_:.\-/]{1,100}$/;

/*
 * Guarda (o cambia) la configuración y la deja PENDIENTE de probar. Antes
 * comprueba que el emisor publica su configuración OpenID y que casa. Si el
 * secreto viene vacío y es el mismo cliente, se queda el que había.
 */
export async function guardarOidc(
	quien: string,
	datos: DatosOidc,
	comprobar: (emisor: string) => Promise<unknown> = descubrir
): Promise<{ ok: true } | { ok: false; error: string }> {
	const emisor = datos.emisor.trim().replace(/\/+$/, '');
	const clientId = datos.clientId.trim();
	const secreto = datos.secreto.trim();
	const claim = datos.claim.trim() || 'groups';
	if (!urlSegura(emisor))
		return {
			ok: false,
			error: 'The issuer is an https:// address, such as https://company.okta.com.'
		};
	if (!clientId || clientId.length > 255) return { ok: false, error: 'The client ID is missing.' };
	if (secreto.length > 1024) return { ok: false, error: 'That secret is too long.' };
	if (!CLAIM.test(claim))
		return {
			ok: false,
			error: 'The roles claim is a name such as groups, roles or realm_access.roles.'
		};
	const roles: MapaRoles = {};
	for (const r of ROLES) {
		const v = lista(datos.roles[r] ?? '');
		if (v.length) roles[r] = v.map((x) => x.slice(0, 200)).slice(0, 50);
	}
	if (!roles.admin?.length)
		return {
			ok: false,
			error:
				'Map at least one value to the Administrator role: the test sign-in has to come back as admin.'
		};
	if (estadoClave() !== 'lista')
		return {
			ok: false,
			error:
				'This node does not have its key for storing secrets (CLAVE_SECRETOS in the .env file).'
		};

	const previo = await leer();
	let sobre: string;
	let fin: string | null;
	if (secreto) {
		sobre = cifrar({ secreto }, CONTEXTO);
		fin = final(secreto);
	} else if (
		previo &&
		previo.clientId === clientId &&
		previo.emisor === emisor &&
		descifrar(previo.secreto, CONTEXTO).ok
	) {
		sobre = previo.secreto;
		fin = previo.final;
	} else return { ok: false, error: 'The client secret is missing.' };

	try {
		await comprobar(emisor);
	} catch (e) {
		return {
			ok: false,
			error: `The issuer could not be checked: ${(e as Error).message} Check the address and that the node can reach it.`
		};
	}

	await escribir({
		emisor,
		clientId,
		secreto: sobre,
		final: fin,
		nombre: datos.nombre.trim().slice(0, 40) || 'single sign-on',
		alcances: lista(datos.alcances.replace(/\s+/g, ',')).join(' ') || 'profile email',
		claim,
		roles,
		exigirMfa: datos.exigirMfa,
		acr: lista(datos.acr).slice(0, 10),
		activo: false,
		guardadoPor: quien,
		guardado: new Date().toISOString()
	});
	await auditar(quien, 'OIDC sign-in saved, pending test', {
		emisor,
		clientId,
		exigirMfa: datos.exigirMfa
	});
	if (!datos.exigirMfa)
		await auditar(quien, 'OIDC sign-in: two-factor from the identity provider not required', {
			emisor
		});
	return { ok: true };
}

/* La prueba salió bien: a partir de ahora se entra también con este proveedor. */
export async function activarOidc(quien: string, probadoCon: string) {
	const g = await leer();
	if (!g) return false;
	await escribir({
		...g,
		activo: true,
		activadoPor: probadoCon,
		activado: new Date().toISOString()
	});
	await auditar(quien, 'OIDC sign-in enabled', {
		emisor: g.emisor,
		clientId: g.clientId,
		probadaCon: probadoCon
	});
	return true;
}

/* Quitarlo no puede dejar la consola sin entrada (solo con la llave de emergencia). */
export async function quitarOidc(
	quien: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	const g = await leer();
	if (!g) return { ok: true };
	const [entra] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'entra_propio'));
	const entraActivo = !!(entra?.valor as { activo?: boolean } | undefined)?.activo;
	const b2b = configuradoEnEntorno() && !(await retiradaB2B());
	if (g.activo && !loginLocalHabilitado() && !entraActivo && !b2b)
		return {
			ok: false,
			error:
				'This is the only way to sign in to this console: removing it would leave only the emergency sign-in. Change it instead.'
		};
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_OIDC));
	await auditar(quien, 'OIDC sign-in removed', { emisor: g.emisor });
	return { ok: true };
}

export type RechazoOidc = 'sin_oid' | 'sin_correo' | 'sin_rol' | 'sin_mfa';

/* Los roles que dan los valores de la claim, según el mapa. */
export function rolesOidc(p: JWTPayload, claim: string, mapa: MapaRoles): Rol[] {
	const valores = new Set(valoresClaim(p, claim));
	return ROLES.filter((r) => (mapa[r] ?? []).some((v) => valores.has(v)));
}

/*
 * Quién es, a partir del token ya verificado. El oid lleva una huella del
 * emisor: si mañana se cambia de proveedor, un `sub` igual en el nuevo no es la
 * misma persona (preferencias, tokens de API).
 */
export function identidadOidc(
	p: JWTPayload,
	g: Pick<Guardado, 'emisor' | 'claim' | 'roles' | 'exigirMfa' | 'acr'>
): Identidad | { rechazo: RechazoOidc } {
	if (typeof p.sub !== 'string' || !p.sub) return { rechazo: 'sin_oid' };
	if (g.exigirMfa && !huboMfa(p, g.acr)) return { rechazo: 'sin_mfa' };
	const roles = rolesOidc(p, g.claim, g.roles);
	if (roles.length === 0) return { rechazo: 'sin_rol' };
	const correo = correoOidc(p);
	if (!correo) return { rechazo: 'sin_correo' };
	const nombre = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : correo;
	const iss = createHash('sha256').update(g.emisor).digest('hex').slice(0, 8);
	return { oid: `oidc:${iss}:${p.sub}`, correo, nombre, roles, soporte: false };
}
