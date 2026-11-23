/*
 * Entrar con el proveedor de identidad DEL CLIENTE por SAML 2.0: ADFS, Okta,
 * Ping, Keycloak, Entra ID como IdP SAML, Shibboleth… (plan de fortificación
 * §4.2, B-10 punto 2). Mismo patrón que oidc-propio.ts: se guarda en `ajustes`,
 * queda PENDIENTE y solo se activa cuando un administrador hace una entrada de
 * prueba y vuelve con el rol admin. Un dato mal copiado no deja a nadie fuera.
 *
 * La consola es el SP: su entidad es `<origen>/auth/saml/metadata` (de ahí se
 * descargan sus metadatos) y su ACS `<origen>/auth/saml/acs`, fijados con el
 * origen con el que se guardó. Tiene su propio par de claves (generado al
 * guardar la primera vez, la privada cifrada con la clave del nodo): firma las
 * idas y el proveedor puede cifrar las aserciones con su certificado.
 *
 * La validación está en saml.ts. Aquí: guardar, activar, quitar, la identidad
 * (roles por atributo, MFA por AuthnContext) y las idas pendientes en memoria.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, like, ne } from 'drizzle-orm';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { cifrar, descifrar, estadoClave } from '../secretos';
import { retiradaB2B } from './b2b';
import { configuradoEnEntorno, type Identidad } from './entra';
import { loginLocalHabilitado } from './local';
import { lista, type MapaRoles } from './oidc-propio';
import { ROLES, type Rol } from './permisos';
import {
	ATRIBUTOS_NOMBRE,
	CacheAcotada,
	NAMEID_TRANSITORIO,
	VIDA_IDA_MS,
	comprobarIdp,
	correoSaml,
	cuerpoCert,
	datosCert,
	generarClavesSp,
	huboMfaSaml,
	leerMetadatosIdp,
	primerAtributo,
	type Afirmacion,
	type ConfigSaml,
	type Idp
} from './saml';

/* Lo leen también entra-propio.ts y oidc-propio.ts (sin importar este módulo). */
export const AJUSTE_SAML = 'saml_propio';
const CONTEXTO = 'saml-propio';
export const COOKIE_SAML_PROPIO = 'sd_saml_propio';
export const RUTA_ACS = '/auth/saml/acs';
export const RUTA_METADATOS = '/auth/saml/metadata';

type Guardado = Idp & {
	origen: string;
	/* La clave privada del SP, cifrada; el certificado va en claro (es público). */
	claveSp: string;
	certSp: string;
	nombre: string;
	atributoRoles: string;
	atributoCorreo: string;
	roles: MapaRoles;
	exigirMfa: boolean;
	contextos: string[];
	pedirContexto: boolean;
	exigirCifrado: boolean;
	activo: boolean;
	guardadoPor: string;
	guardado: string;
	activadoPor?: string;
	activado?: string;
};

async function leer(): Promise<Guardado | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_SAML));
	return (f?.valor as Guardado | undefined) ?? null;
}

async function escribir(v: Guardado) {
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE_SAML, valor: v })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: v } });
}

const spDe = (origen: string) => ({
	spEntidad: origen + RUTA_METADATOS,
	acs: origen + RUTA_ACS
});

/* Lo que se puede enseñar en Ajustes: todo menos la clave privada. */
export async function estadoSaml() {
	const g = await leer();
	if (!g) return null;
	const { claveSp, ...resto } = g;
	return {
		...resto,
		...spDe(g.origen),
		legible: descifrar(claveSp, CONTEXTO).ok,
		certificados: g.certs.map((c) => datosCert(c)),
		certificadoSp: datosCert(cuerpoCert(g.certSp))
	};
}

export type Saml = { config: ConfigSaml; guardado: Omit<Guardado, 'claveSp'> };

/* La configuración, esté activa o pendiente de probar. */
export async function configSaml(): Promise<Saml | null> {
	const g = await leer();
	if (!g) return null;
	const d = descifrar(g.claveSp, CONTEXTO);
	if (!d.ok) return null;
	const { claveSp, ...guardado } = g;
	void claveSp;
	return {
		config: {
			entidad: g.entidad,
			sso: g.sso,
			certs: g.certs,
			...spDe(g.origen),
			claveSp: d.valores.clave,
			certSp: g.certSp,
			contextos: g.contextos,
			pedirContexto: g.pedirContexto,
			exigirCifrado: g.exigirCifrado
		},
		guardado
	};
}

/* La activa, si la hay: la que sale en la pantalla de entrada. */
export async function samlActivo(): Promise<Saml | null> {
	const c = await configSaml();
	return c?.guardado.activo ? c : null;
}

export type DatosSaml = {
	metadatos: string;
	entidad: string;
	sso: string;
	cert: string;
	nombre: string;
	atributoRoles: string;
	atributoCorreo: string;
	roles: Record<string, string>;
	exigirMfa: boolean;
	contextos: string;
	pedirContexto: boolean;
	exigirCifrado: boolean;
};

const ATRIBUTO = /^[A-Za-z0-9_:.\-/#]{1,200}$/;

/*
 * Guarda (o cambia) la configuración y la deja PENDIENTE de probar. El
 * proveedor sale de sus metadatos (pegados) o de los tres campos a mano. La
 * primera vez genera las claves del SP; después se quedan (el proveedor ya
 * tiene su certificado).
 */
export async function guardarSaml(
	quien: string,
	origen: string,
	datos: DatosSaml
): Promise<{ ok: true } | { ok: false; error: string }> {
	const previo = await leer();
	let idp: Idp;
	if (datos.metadatos.trim()) {
		const m = leerMetadatosIdp(datos.metadatos.trim());
		if ('error' in m) return { ok: false, error: m.error };
		idp = m;
	} else {
		const certs = (
			datos.cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [
				datos.cert
			]
		)
			.map(cuerpoCert)
			.filter(Boolean);
		const entidad = datos.entidad.trim();
		/* Sin certificado y el mismo proveedor: se quedan los guardados. */
		idp = {
			entidad,
			sso: datos.sso.trim(),
			certs: certs.length || previo?.entidad !== entidad ? certs : previo.certs
		};
	}
	const mal = comprobarIdp(idp);
	if (mal) return { ok: false, error: mal };
	const atributoRoles = datos.atributoRoles.trim() || 'groups';
	const atributoCorreo = datos.atributoCorreo.trim();
	if (!ATRIBUTO.test(atributoRoles) || (atributoCorreo && !ATRIBUTO.test(atributoCorreo)))
		return {
			ok: false,
			error:
				'An attribute name is a name or URI such as groups, memberOf or http://schemas.microsoft.com/ws/2008/06/identity/claims/role.'
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
	const contextos = lista(datos.contextos)
		.map((x) => x.slice(0, 300))
		.slice(0, 10);
	if (datos.pedirContexto && !contextos.length)
		return {
			ok: false,
			error: 'To request an authentication context, list at least one accepted value.'
		};
	if (estadoClave() !== 'lista')
		return {
			ok: false,
			error:
				'This node does not have its key for storing secrets (CLAVE_SECRETOS in the .env file).'
		};

	let claveSp: string;
	let certSp: string;
	if (previo && previo.origen === origen && descifrar(previo.claveSp, CONTEXTO).ok) {
		claveSp = previo.claveSp;
		certSp = previo.certSp;
	} else {
		const par = await generarClavesSp(`Sugardaddy console ${new URL(origen).hostname}`);
		claveSp = cifrar({ clave: par.clave }, CONTEXTO);
		certSp = par.cert;
	}

	await escribir({
		...idp,
		origen,
		claveSp,
		certSp,
		nombre: datos.nombre.trim().slice(0, 40) || 'single sign-on',
		atributoRoles,
		atributoCorreo,
		roles,
		exigirMfa: datos.exigirMfa,
		contextos,
		pedirContexto: datos.pedirContexto,
		exigirCifrado: datos.exigirCifrado,
		activo: false,
		guardadoPor: quien,
		guardado: new Date().toISOString()
	});
	olvidarIdas();
	await auditar(quien, 'SAML sign-in saved, pending test', {
		entidad: idp.entidad,
		sso: idp.sso,
		certificados: idp.certs.map((c) => datosCert(c)?.huella),
		exigirMfa: datos.exigirMfa,
		exigirCifrado: datos.exigirCifrado
	});
	if (!datos.exigirMfa)
		await auditar(quien, 'SAML sign-in: two-factor from the identity provider not required', {
			entidad: idp.entidad
		});
	return { ok: true };
}

/* La prueba salió bien: a partir de ahora se entra también con este proveedor. */
export async function activarSaml(quien: string, probadoCon: string) {
	const g = await leer();
	if (!g) return false;
	await escribir({
		...g,
		activo: true,
		activadoPor: probadoCon,
		activado: new Date().toISOString()
	});
	await auditar(quien, 'SAML sign-in enabled', { entidad: g.entidad, probadaCon: probadoCon });
	return true;
}

const activoEn = async (clave: string) => {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, clave));
	return !!(f?.valor as { activo?: boolean } | undefined)?.activo;
};

/* Quitarlo no puede dejar la consola sin entrada (solo con la llave de emergencia). */
export async function quitarSaml(
	quien: string,
	salvo: string | null = null
): Promise<{ ok: true } | { ok: false; error: string }> {
	const g = await leer();
	if (!g) return { ok: true };
	const b2b = configuradoEnEntorno() && !(await retiradaB2B());
	if (
		g.activo &&
		!loginLocalHabilitado() &&
		!b2b &&
		!(await activoEn('entra_propio')) &&
		!(await activoEn('oidc_propio'))
	)
		return {
			ok: false,
			error:
				'This is the only way to sign in to this console: removing it would leave only the emergency sign-in. Change it instead.'
		};
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, AJUSTE_SAML));
	olvidarIdas();
	/* Las sesiones abiertas con él se cierran con él (como el Entra propio), salvo la de quien lo quita. */
	if (g.activo)
		await db
			.update(s.sesiones)
			.set({ cerrada: new Date() })
			.where(
				and(
					isNull(s.sesiones.cerrada),
					like(s.sesiones.oid, 'saml:%'),
					...(salvo ? [ne(s.sesiones.id, salvo)] : [])
				)
			);
	await auditar(quien, 'SAML sign-in removed', { entidad: g.entidad });
	return { ok: true };
}

export type RechazoSaml = 'sin_oid' | 'sin_correo' | 'sin_rol' | 'sin_mfa';

/* Los roles que dan los valores del atributo, según el mapa. */
export function rolesSaml(a: Afirmacion, atributo: string, mapa: MapaRoles): Rol[] {
	const valores = new Set(a.atributos[atributo] ?? []);
	return ROLES.filter((r) => (mapa[r] ?? []).some((v) => valores.has(v)));
}

/*
 * Quién es, a partir de la aserción ya validada. El oid lleva una huella de la
 * entidad del proveedor, como en OIDC. Un NameID transitorio cambia en cada
 * entrada: no identifica a nadie.
 */
export function identidadSaml(
	a: Afirmacion,
	g: Pick<
		Guardado,
		'entidad' | 'atributoRoles' | 'atributoCorreo' | 'roles' | 'exigirMfa' | 'contextos'
	>
): Identidad | { rechazo: RechazoSaml } {
	if (!a.nameId || a.nameId.length > 256 || a.formato === NAMEID_TRANSITORIO)
		return { rechazo: 'sin_oid' };
	if (g.exigirMfa && !huboMfaSaml(a, g.contextos)) return { rechazo: 'sin_mfa' };
	const roles = rolesSaml(a, g.atributoRoles, g.roles);
	if (roles.length === 0) return { rechazo: 'sin_rol' };
	const correo = correoSaml(a, g.atributoCorreo);
	if (!correo) return { rechazo: 'sin_correo' };
	const nombre = primerAtributo(a, ATRIBUTOS_NOMBRE)?.slice(0, 200) || correo;
	const iss = createHash('sha256').update(g.entidad).digest('hex').slice(0, 8);
	return { oid: `saml:${iss}:${a.nameId}`, correo, nombre, roles, soporte: false };
}

/*
 * Idas pendientes, en memoria. El proveedor vuelve con un POST desde su dominio
 * y la cookie de la consola (SameSite=Lax) no viaja en él: el RelayState dice
 * qué ida es (y si es una prueba), y el resultado se guarda aquí con una ficha
 * de un solo uso hasta que el navegador llega, ya con su cookie, a
 * /auth/saml/fin. Allí la cookie de la ida tiene que casar.
 */
type Ida = { probar: boolean; caduca: number };
export type Resultado = { identidad: Identidad; relay: string; probar: boolean; caduca: number };
const MAXIMO = 2000;
const idas = new Map<string, Ida>();
const resultados = new Map<string, Resultado>();
let cache = new CacheAcotada();

/* La caché de node-saml, una por configuración: cambiarla olvida las idas a medias. */
export function cacheSaml() {
	return cache;
}

function olvidarIdas() {
	idas.clear();
	resultados.clear();
	cache = new CacheAcotada();
}

function podar<T extends { caduca: number }>(m: Map<string, T>) {
	const t = Date.now();
	for (const [k, v] of m) if (v.caduca <= t) m.delete(k);
	return m.size < MAXIMO;
}

/* Una ida nueva: su RelayState. null si hay demasiadas a medias. */
export function nuevaIda(probar: boolean): string | null {
	if (idas.size >= MAXIMO && !podar(idas)) return null;
	const relay = randomBytes(24).toString('base64url');
	idas.set(relay, { probar, caduca: Date.now() + VIDA_IDA_MS });
	return relay;
}

/* La ida de un RelayState, gastándola: cada una vale para una sola vuelta. */
export function gastarIda(relay: string): Ida | null {
	const i = idas.get(relay);
	idas.delete(relay);
	return i && i.caduca > Date.now() ? i : null;
}

/* Guarda el resultado de una vuelta buena; devuelve la ficha para /auth/saml/fin. */
export function guardarResultado(r: Omit<Resultado, 'caduca'>): string | null {
	if (resultados.size >= MAXIMO && !podar(resultados)) return null;
	const ficha = randomBytes(24).toString('base64url');
	resultados.set(ficha, { ...r, caduca: Date.now() + 2 * 60_000 });
	return ficha;
}

export function gastarResultado(ficha: string): Resultado | null {
	const r = resultados.get(ficha);
	resultados.delete(ficha);
	return r && r.caduca > Date.now() ? r : null;
}
