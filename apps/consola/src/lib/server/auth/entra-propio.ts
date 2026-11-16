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
 * tiene una URL de retorno y un emisor que comprobar. Y con el B2B retirado
 * (b2b.ts), el del .env no vale nunca, ni aunque el propio falle.
 *
 * MFA (auditoría 2026-11-14): de serie se exige que el token la diga, como en
 * el OIDC genérico. Las configuraciones guardadas antes de esto no traen el
 * campo `exigirMfa`: son «heredadas» y no se cierran de golpe al actualizar.
 * Si su token no trae MFA, entran igual, queda en la auditoría (clase
 * auditoria.fallo) y los administradores ven un aviso fijo hasta que activan
 * la exigencia, que solo se guarda tras una entrada de prueba con MFA.
 * Guardar el formulario de nuevo la deja exigida (o apagada a propósito).
 * Entra la dice en `amr` o, de forma fiable, en `acrs` cuando se pide un
 * contexto de autenticación (c1…c99) cuya directiva de acceso condicional
 * exige MFA. Apagarla pide una confirmación explícita y queda en la auditoría.
 */
import { and, eq, isNull, ne, notLike } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { canjear, CONTEXTO_AUTH, huboMfaEntra, type Config } from '@sugardaddy/entra';
import { db, schema as s } from '../db';
import { auditar } from '../consultas';
import { cifrar, descifrar, estadoClave, final } from '../secretos';
import { retiradaB2B } from './b2b';
import { loginLocalHabilitado } from './local';
import {
	configEntorno,
	configuradoEnEntorno,
	identidadDesdePayload,
	identidadPropia,
	type ExigenciaMfa,
	type PuertaInvitado,
	type PuertaSoporte
} from './entra';

const AJUSTE = 'entra_propio';
/* Casa con «sign-in failed» de salidas/auditoria.ts: sale al SIEM como auditoria.fallo. */
export const ACCION_SIN_MFA =
	'sign-in failed the MFA check (no MFA in the Microsoft token; allowed until enforcement is turned on)';
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
	/* Sin el campo: guardada antes de 2026-11-15, MFA «heredada» (ver arriba). */
	exigirMfa?: boolean;
	contextoAuth?: string | null;
};

/*
 * Cómo trata la MFA: exigida, apagada a propósito o heredada (de antes de
 * exigirla: deja entrar sin ella, pero lo apunta y avisa).
 */
export type ModoMfa = 'exigida' | 'apagada' | 'heredada';
const modoMfa = (g: Guardado): ModoMfa =>
	g.exigirMfa === undefined ? 'heredada' : g.exigirMfa ? 'exigida' : 'apagada';

/* La configuración con la que se entra y la exigencia de MFA que la acompaña. */
export type ConfigPropia = Config & ExigenciaMfa & { modoMfa: ModoMfa };

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
	return {
		...resto,
		exigirMfa: modoMfa(g) === 'exigida',
		modoMfa: modoMfa(g),
		contextoAuth: g.contextoAuth ?? null,
		legible: descifrar(secreto, CONTEXTO).ok
	};
}

/* La configuración del cliente, esté activa o pendiente de probar. */
export async function configPropia(): Promise<ConfigPropia | null> {
	const g = await leer();
	if (!g) return null;
	const d = descifrar(g.secreto, CONTEXTO);
	return d.ok
		? {
				tenant: g.tenant,
				clientId: g.clientId,
				secret: d.valores.secreto,
				exigirMfa: modoMfa(g) === 'exigida',
				modoMfa: modoMfa(g),
				contextoAuth: g.contextoAuth ?? null
			}
		: null;
}

/*
 * Activa la exigencia en una configuración heredada (o apagada), tras una
 * entrada de prueba que ya trajo MFA: así nadie se cierra la puerta.
 */
export async function activarExigenciaMfa(
	quien: string,
	probadoCon: string,
	contextoAuth: string | null
) {
	const g = await leer();
	if (!g) return false;
	await escribir({ ...g, exigirMfa: true, contextoAuth });
	await auditar(quien, 'Microsoft sign-in (own Entra): MFA enforcement turned on', {
		tenant: g.tenant,
		contextoAuth,
		probadaCon: probadoCon
	});
	return true;
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
	datos: {
		tenant: string;
		clientId: string;
		secreto: string;
		/* Sin indicar: exigida. Para apagarla hace falta además `confirmarSinMfa`. */
		exigirMfa?: boolean;
		confirmarSinMfa?: boolean;
		contextoAuth?: string;
	},
	comprobar: (t: string) => Promise<'si' | 'no' | 'sin-red'> = existeTenant
): Promise<{ ok: true } | { ok: false; error: string }> {
	const tenant = datos.tenant.trim().toLowerCase();
	const clientId = datos.clientId.trim().toLowerCase();
	const secreto = datos.secreto.trim();
	const exigirMfa = datos.exigirMfa !== false;
	const contextoAuth = (datos.contextoAuth ?? '').trim().toLowerCase() || null;
	if (contextoAuth && !CONTEXTO_AUTH.test(contextoAuth))
		return {
			ok: false,
			error:
				'The authentication context ID is the one shown in Entra ID > Conditional Access > Authentication contexts: c1 to c99.'
		};
	if (!exigirMfa && !datos.confirmarSinMfa)
		return {
			ok: false,
			error:
				'To stop requiring MFA from Microsoft, also tick the box that confirms it. It will be recorded in the audit log.'
		};
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
		guardado: new Date().toISOString(),
		exigirMfa,
		contextoAuth
	});
	await auditar(quien, 'Microsoft sign-in (own Entra) saved, pending test', {
		tenant,
		clientId,
		exigirMfa,
		contextoAuth
	});
	if (!exigirMfa)
		await auditar(quien, 'Microsoft sign-in (own Entra): two-factor from Entra not required', {
			tenant
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

/*
 * Quitarlo no puede dejar la consola sin entrada: sin login local y sin el Entra
 * de SeguridadSI (retirado o que nunca hubo), solo quedaría la llave de emergencia.
 */
export async function quitarEntraPropio(
	quien: string,
	salvo: string | null = null
): Promise<{ ok: true } | { ok: false; error: string }> {
	const g = await leer();
	if (!g) return { ok: true };
	const b2b = configuradoEnEntorno() && !(await retiradaB2B());
	/* El OIDC propio activo (oidc-propio.ts, ajuste «oidc_propio») también es una entrada. */
	const [oidc] = await db.select().from(s.ajustes).where(eq(s.ajustes.clave, 'oidc_propio'));
	const oidcActivo = !!(oidc?.valor as { activo?: boolean } | undefined)?.activo;
	if (g.activo && !loginLocalHabilitado() && !b2b && !oidcActivo)
		return {
			ok: false,
			error:
				'This is the only way to sign in to this console: removing it would leave only the emergency key. Change it instead.'
		};
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, AJUSTE));
	/*
	 * Las sesiones abiertas con ese Entra se cierran con él (auditoría
	 * 2026-11-14, §5 h01), salvo la de quien lo quita. Con el B2B aún vivo, las
	 * de Microsoft son de los dos y se cierran todas: quien siga con el de
	 * SeguridadSI vuelve a entrar.
	 */
	if (g.activo)
		await db
			.update(s.sesiones)
			.set({ cerrada: new Date() })
			.where(
				and(
					isNull(s.sesiones.cerrada),
					notLike(s.sesiones.oid, 'local:%'),
					notLike(s.sesiones.oid, 'emergencia:%'),
					notLike(s.sesiones.oid, 'oidc:%'),
					...(salvo ? [ne(s.sesiones.id, salvo)] : [])
				)
			);
	await auditar(quien, 'Microsoft sign-in (own Entra) removed');
	return { ok: true };
}

/* Con qué Entra se entra ahora mismo, si con alguno. */
export type Activa =
	{ modo: 'propio'; config: ConfigPropia } | { modo: 'seguridadsi'; config: Config; grupo: string };

export async function configActiva(): Promise<Activa | null> {
	const g = await leer();
	if (g?.activo) {
		const c = await configPropia();
		if (c) return { modo: 'propio', config: c };
	}
	if (configuradoEnEntorno() && !(await retiradaB2B()))
		return { modo: 'seguridadsi', config: configEntorno(), grupo: env.ENTRA_GRUPO_CLIENTE! };
	return null;
}

export async function canjearCodigo(
	activa: Activa,
	o: Parameters<typeof canjear>[1],
	puertas: { grupo: PuertaSoporte; invitado: PuertaInvitado }
) {
	const p = await canjear(activa.config, o);
	if (activa.modo !== 'propio') return identidadDesdePayload(p, activa.grupo, puertas.grupo);
	const r = identidadPropia(p, puertas.invitado, activa.config);
	/* Heredada: entra sin MFA, pero queda dicho (clase auditoria.fallo). */
	if (
		!('rechazo' in r) &&
		activa.config.modoMfa === 'heredada' &&
		!huboMfaEntra(p, activa.config.contextoAuth)
	)
		await auditar(r.correo, ACCION_SIN_MFA, { tenant: activa.config.tenant });
	return r;
}
