/*
 * OpenID Connect con cualquier proveedor de identidad (Okta, Ping, ADFS,
 * Keycloak, Auth0, Google Workspace…): descubrimiento, flujo de código de
 * autorización con PKCE y el id_token verificado (firma con las claves del
 * proveedor, emisor, audiencia, caducidad, azp y nonce). Es lo mismo que
 * index.ts hace con Microsoft, pero sin nada de Microsoft.
 *
 * Aquí no se decide quién puede entrar ni con qué rol: eso lo decide la
 * aplicación con el payload verificado que devuelve `canjearOidc`.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type ConfigOidc = {
	/* El emisor exacto (iss), p. ej. https://empresa.okta.com o https://sso.empresa.com/realms/x. */
	emisor: string;
	clientId: string;
	secret: string;
	/* Alcances además de «openid» (de serie, «profile email»). */
	alcances?: string;
	/* Si se piden valores de acr concretos (acr_values), p. ej. el de MFA del proveedor. */
	acr?: string[];
};

export type Descubrimiento = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	end_session_endpoint?: string;
	token_endpoint_auth_methods_supported?: string[];
	code_challenge_methods_supported?: string[];
	id_token_signing_alg_values_supported?: string[];
};

const sinBarra = (u: string) => u.replace(/\/+$/, '');

/* Solo https (o http a localhost, para probar): el secreto y el código viajan por ahí. */
export function urlSegura(u: string): boolean {
	try {
		const x = new URL(u);
		if (x.username || x.password) return false;
		if (x.protocol === 'https:') return true;
		return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
	} catch {
		return false;
	}
}

const cache = new Map<string, { d: Descubrimiento; hasta: number }>();
const VIDA_CACHE = 60 * 60_000;

/*
 * Lee /.well-known/openid-configuration del emisor y comprueba lo que manda la
 * norma (OIDC Discovery §4.3): que el issuer publicado sea el mismo que se pidió
 * y que todos los puntos sean https. Una hora en memoria.
 */
export async function descubrir(
	emisor: string,
	f: typeof fetch = fetch,
	ahora = Date.now()
): Promise<Descubrimiento> {
	const base = sinBarra(emisor);
	const c = cache.get(base);
	if (c && c.hasta > ahora) return c.d;
	if (!urlSegura(base)) throw new Error('The issuer must be an https:// address.');
	const r = await f(`${base}/.well-known/openid-configuration`, {
		signal: AbortSignal.timeout(8000),
		redirect: 'error'
	});
	if (!r.ok) throw new Error(`The provider answered ${r.status} to the discovery request.`);
	const d = (await r.json()) as Partial<Descubrimiento>;
	if (typeof d.issuer !== 'string' || sinBarra(d.issuer) !== base)
		throw new Error(`The provider says its issuer is "${d.issuer}", not "${emisor}".`);
	for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
		if (typeof d[k] !== 'string' || !urlSegura(d[k]))
			throw new Error(`The provider's ${k} is missing or is not https.`);
	if (d.end_session_endpoint !== undefined && !urlSegura(d.end_session_endpoint))
		delete d.end_session_endpoint;
	const listo = d as Descubrimiento;
	cache.set(base, { d: listo, hasta: ahora + VIDA_CACHE });
	return listo;
}

export function _olvidarDescubrimientos() {
	cache.clear();
}

const aleatorio = (n: number) =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');
export const generarEstadoOidc = () => aleatorio(24);
export const generarVerificadorOidc = () => aleatorio(32);

async function reto(verificador: string) {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador));
	return Buffer.from(d).toString('base64url');
}

const alcancesDe = (c: ConfigOidc) => {
	const extra = (c.alcances ?? 'profile email').split(/\s+/).filter((a) => a && a !== 'openid');
	return ['openid', ...new Set(extra)].join(' ');
};

export async function urlDeAutorizacionOidc(
	c: ConfigOidc,
	d: Descubrimiento,
	o: { redirectUri: string; estado: string; nonce: string; verificador: string }
) {
	const p = new URLSearchParams({
		client_id: c.clientId,
		response_type: 'code',
		redirect_uri: o.redirectUri,
		scope: alcancesDe(c),
		state: o.estado,
		nonce: o.nonce,
		code_challenge: await reto(o.verificador),
		code_challenge_method: 'S256',
		prompt: 'login'
	});
	if (c.acr?.length) p.set('acr_values', c.acr.join(' '));
	const u = new URL(d.authorization_endpoint);
	for (const [k, v] of p) u.searchParams.set(k, v);
	return u.toString();
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function claves(uri: string) {
	let j = jwks.get(uri);
	if (!j) {
		j = createRemoteJWKSet(new URL(uri));
		jwks.set(uri, j);
	}
	return j;
}

/* Firmas asimétricas solo: un HS256 con el secreto del cliente no se acepta. */
const ALGORITMOS = [
	'RS256',
	'RS384',
	'RS512',
	'PS256',
	'PS384',
	'PS512',
	'ES256',
	'ES384',
	'ES512',
	'EdDSA'
];

export async function canjearOidc(
	c: ConfigOidc,
	d: Descubrimiento,
	o: { codigo: string; redirectUri: string; verificador: string; nonce: string },
	f: typeof fetch = fetch
): Promise<JWTPayload> {
	const cuerpo = new URLSearchParams({
		grant_type: 'authorization_code',
		code: o.codigo,
		redirect_uri: o.redirectUri,
		code_verifier: o.verificador
	});
	const cabeceras: Record<string, string> = {
		'content-type': 'application/x-www-form-urlencoded',
		accept: 'application/json'
	};
	/*
	 * client_secret_basic es el de serie de la norma; si el proveedor dice que
	 * solo admite client_secret_post, se manda en el cuerpo.
	 */
	const metodos = d.token_endpoint_auth_methods_supported;
	if (
		metodos &&
		!metodos.includes('client_secret_basic') &&
		metodos.includes('client_secret_post')
	) {
		cuerpo.set('client_id', c.clientId);
		cuerpo.set('client_secret', c.secret);
	} else {
		const u = encodeURIComponent;
		cabeceras.authorization = `Basic ${Buffer.from(`${u(c.clientId)}:${u(c.secret)}`).toString('base64')}`;
	}
	const r = await f(d.token_endpoint, {
		method: 'POST',
		headers: cabeceras,
		body: cuerpo,
		signal: AbortSignal.timeout(10_000),
		redirect: 'error'
	});
	const j = (await r.json().catch(() => ({}))) as {
		id_token?: string;
		error?: string;
		error_description?: string;
	};
	if (!r.ok || !j.id_token)
		throw new Error(`Code exchange rejected: ${j.error_description ?? j.error ?? r.status}`);

	const { payload } = await jwtVerify(j.id_token, claves(d.jwks_uri), {
		issuer: d.issuer,
		audience: c.clientId,
		algorithms: ALGORITMOS,
		clockTolerance: 60
	});
	if (payload.nonce !== o.nonce) throw new Error('The token nonce does not match.');
	/* Con varias audiencias, azp tiene que ser este cliente (OIDC Core §3.1.3.7). */
	if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== c.clientId)
		throw new Error('The token was issued to another client.');
	return payload;
}

/*
 * ¿Dice el token que hubo MFA? RFC 8176: `amr` con «mfa», o con dos métodos de
 * tipo distinto; ADFS usa su propia URI. O, si se configuró, un `acr` de la
 * lista (Keycloak, Ping y los niveles de garantía se expresan así).
 */
const AMR_MFA = new Set(['mfa', 'http://schemas.microsoft.com/claims/multipleauthn']);
const AMR_FACTOR: Record<string, string> = {
	pwd: 'sabe',
	pin: 'sabe',
	kba: 'sabe',
	otp: 'tiene',
	sms: 'tiene',
	tel: 'tiene',
	hwk: 'tiene',
	swk: 'tiene',
	sc: 'tiene',
	pop: 'tiene',
	fpt: 'es',
	face: 'es',
	iris: 'es',
	retina: 'es',
	vbm: 'es',
	user: 'es'
};

export function huboMfa(p: JWTPayload, acrAceptados: string[] = []): boolean {
	const amr = Array.isArray(p.amr) ? p.amr.filter((x): x is string => typeof x === 'string') : [];
	if (amr.some((a) => AMR_MFA.has(a))) return true;
	const tipos = new Set(amr.map((a) => AMR_FACTOR[a]).filter(Boolean));
	if (tipos.size >= 2) return true;
	return typeof p.acr === 'string' && acrAceptados.includes(p.acr);
}

/* El correo del token: email, o preferred_username / upn si tienen forma de correo. */
export function correoOidc(p: JWTPayload): string | undefined {
	for (const k of ['email', 'preferred_username', 'upn'])
		if (typeof p[k] === 'string' && /^[^\s@]+@[^\s@]+$/.test(p[k] as string))
			return (p[k] as string).toLowerCase();
	return undefined;
}

/*
 * Los valores de una «claim» del token (grupos o roles), venga como lista o como
 * texto. Admite rutas con puntos (realm_access.roles de Keycloak).
 */
export function valoresClaim(p: JWTPayload, claim: string): string[] {
	let v: unknown = p;
	for (const parte of claim.split('.')) {
		if (!v || typeof v !== 'object') return [];
		v = (v as Record<string, unknown>)[parte];
	}
	if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
