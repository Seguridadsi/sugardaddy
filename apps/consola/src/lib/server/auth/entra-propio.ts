/*
 * Entrar con Microsoft usando el Entra ID DEL CLIENTE: su tenant y un registro
 * de aplicación que crea él mismo (Ajustes le da la URL de retorno y un script
 * para Cloud Shell). Vale igual en community y en pago.
 *
 * Se guarda en la tabla de ajustes, con el secreto cifrado con la clave del
 * nodo (secretos.ts). Guardarlo no basta para usarlo: queda pendiente hasta
 * que un administrador hace una entrada de prueba con Microsoft y vuelve con
 * el rol admin. Así un dato mal copiado no deja a nadie fuera, y el login
 * local y la entrada de emergencia siguen ahí de respaldo.
 *
 * Si está activo, manda sobre el Entra de SeguridadSI del .env: un nodo solo
 * tiene una URL de retorno y un emisor que comprobar.
 */
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { canjear, type Config } from '@sugardaddy/entra';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { cifrar, descifrar, estadoClave, final } from '../secretos';
import {
	configEntorno,
	configuradoEnEntorno,
	identidadDesdePayload,
	identidadPropia,
	type PuertaSoporte
} from './entra';

const AJUSTE = 'entra_propio';
const CONTEXTO = 'entra-propio';

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMINIO = /^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

type Guardado = {
	tenant: string;
	clientId: string;
	secreto: string;
	final: string | null;
	activo: boolean;
	guardadoPor: string;
	guardado: string;
	activadoPor?: string;
	activado?: string;
};

async function leer(): Promise<Guardado | null> {
	const [f] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, AJUSTE));
	return (f?.valor as Guardado | undefined) ?? null;
}

async function escribir(v: Guardado) {
	await db
		.insert(s.ajustes)
		.values({ clave: AJUSTE, valor: v })
		.onConflictDoUpdate({ target: s.ajustes.clave, set: { valor: v } });
}

/* Lo que se puede enseñar en Ajustes: todo menos el secreto. */
export async function estadoEntraPropio() {
	const g = await leer();
	if (!g) return null;
	const { secreto, ...resto } = g;
	return { ...resto, legible: descifrar(secreto, CONTEXTO).ok };
}

/* La configuración del cliente, esté activa o pendiente de probar. */
export async function configPropia(): Promise<Config | null> {
	const g = await leer();
	if (!g) return null;
	const d = descifrar(g.secreto, CONTEXTO);
	return d.ok ? { tenant: g.tenant, clientId: g.clientId, secret: d.valores.secreto } : null;
}

/* Que el tenant exista de verdad: Microsoft publica su configuración OpenID. */
export async function existeTenant(tenant: string, f: typeof fetch = fetch) {
	try {
		const r = await f(
			`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`,
			{ signal: AbortSignal.timeout(8000) }
		);
		return r.ok ? 'si' : 'no';
	} catch {
		return 'sin-red';
	}
}

/*
 * Guarda (o cambia) la configuración y la deja PENDIENTE de probar. Si el
 * secreto viene vacío y es la misma aplicación, se queda el que había: así se
 * puede corregir el tenant sin volver a pegarlo.
 */
export async function guardarEntraPropio(
	quien: string,
	datos: { tenant: string; clientId: string; secreto: string },
	comprobar: (t: string) => Promise<'si' | 'no' | 'sin-red'> = existeTenant
): Promise<{ ok: true } | { ok: false; error: string }> {
	const tenant = datos.tenant.trim().toLowerCase();
	const clientId = datos.clientId.trim().toLowerCase();
	const secreto = datos.secreto.trim();
	if (!GUID.test(tenant) && !DOMINIO.test(tenant))
		return {
			ok: false,
			error: 'The tenant is a GUID (or a domain such as company.onmicrosoft.com).'
		};
	if (!GUID.test(clientId)) return { ok: false, error: 'The application (client) ID is a GUID.' };
	if (secreto.length > 256) return { ok: false, error: 'That secret is too long.' };
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
	} else if (previo && previo.clientId === clientId && descifrar(previo.secreto, CONTEXTO).ok) {
		sobre = previo.secreto;
		fin = previo.final;
	} else return { ok: false, error: 'The application secret is missing.' };

	const existe = await comprobar(tenant);
	if (existe === 'no')
		return { ok: false, error: 'Microsoft does not recognize that tenant. Check it.' };
	if (existe === 'sin-red')
		return {
			ok: false,
			error: 'Microsoft cannot be reached from the node. Check its internet access.'
		};

	await escribir({
		tenant,
		clientId,
		secreto: sobre,
		final: fin,
		activo: false,
		guardadoPor: quien,
		guardado: new Date().toISOString()
	});
	await auditar(quien, 'Microsoft sign-in (own Entra) saved, pending test', {
		tenant,
		clientId
	});
	return { ok: true };
}

/* La prueba salió bien: a partir de ahora se entra con este Entra. */
export async function activarEntraPropio(quien: string, probadoCon: string) {
	const g = await leer();
	if (!g) return false;
	await escribir({
		...g,
		activo: true,
		activadoPor: probadoCon,
		activado: new Date().toISOString()
	});
	await auditar(quien, 'Microsoft sign-in (own Entra) enabled', {
		tenant: g.tenant,
		clientId: g.clientId,
		probadaCon: probadoCon
	});
	return true;
}

export async function quitarEntraPropio(quien: string) {
	const [f] = await db.delete(s.ajustes).where(eq(s.ajustes.clave, AJUSTE)).returning();
	if (f) await auditar(quien, 'Microsoft sign-in (own Entra) removed');
	return !!f;
}

/* Con qué Entra se entra ahora mismo, si con alguno. */
export type Activa =
	{ modo: 'propio'; config: Config } | { modo: 'seguridadsi'; config: Config; grupo: string };

export async function configActiva(): Promise<Activa | null> {
	const g = await leer();
	if (g?.activo) {
		const c = await configPropia();
		if (c) return { modo: 'propio', config: c };
	}
	if (configuradoEnEntorno())
		return { modo: 'seguridadsi', config: configEntorno(), grupo: env.ENTRA_GRUPO_CLIENTE! };
	return null;
}

export async function canjearCodigo(
	activa: Activa,
	o: Parameters<typeof canjear>[1],
	soporte: PuertaSoporte
) {
	const p = await canjear(activa.config, o);
	return activa.modo === 'propio'
		? identidadPropia(p)
		: identidadDesdePayload(p, activa.grupo, soporte);
}
