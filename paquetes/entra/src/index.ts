/*
 * Entrada con Microsoft Entra ID, compartida por la consola y el panel
 * central: flujo de código de autorización con PKCE y el id_token verificado
 * (firma, emisor, audiencia, caducidad y nonce).
 *
 * Aquí no se decide quién puede entrar: eso lo decide cada aplicación con el
 * payload verificado que devuelve `canjear`.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const AUTORIDAD = 'https://login.microsoftonline.com';
export const ALCANCES = 'openid profile email';

export type Config = { tenant: string; clientId: string; secret: string };

const aleatorio = (n: number) =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');
export const generarEstado = () => aleatorio(24);
export const generarVerificador = () => aleatorio(32);

async function reto(verificador: string) {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador));
	return Buffer.from(d).toString('base64url');
}

export async function urlDeAutorizacion(
	c: Config,
	o: { redirectUri: string; estado: string; nonce: string; verificador: string }
) {
	const p = new URLSearchParams({
		client_id: c.clientId,
		response_type: 'code',
		redirect_uri: o.redirectUri,
		response_mode: 'query',
		scope: ALCANCES,
		state: o.estado,
		nonce: o.nonce,
		code_challenge: await reto(o.verificador),
		code_challenge_method: 'S256',
		/* Que Microsoft pregunte siempre con qué cuenta: si no, salir no sirve de nada. */
		prompt: 'select_account'
	});
	return `${AUTORIDAD}/${c.tenant}/oauth2/v2.0/authorize?${p}`;
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function claves(tenant: string) {
	let j = jwks.get(tenant);
	if (!j) {
		j = createRemoteJWKSet(new URL(`${AUTORIDAD}/${tenant}/discovery/v2.0/keys`));
		jwks.set(tenant, j);
	}
	return j;
}

export async function canjear(
	c: Config,
	o: { codigo: string; redirectUri: string; verificador: string; nonce: string }
): Promise<JWTPayload> {
	const r = await fetch(`${AUTORIDAD}/${c.tenant}/oauth2/v2.0/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: c.clientId,
			client_secret: c.secret,
			grant_type: 'authorization_code',
			code: o.codigo,
			redirect_uri: o.redirectUri,
			code_verifier: o.verificador,
			scope: ALCANCES
		})
	});
	const cuerpo = (await r.json()) as { id_token?: string; error_description?: string };
	if (!r.ok || !cuerpo.id_token)
		throw new Error(`Canje de código rechazado: ${cuerpo.error_description ?? r.status}`);

	const { payload } = await jwtVerify(cuerpo.id_token, claves(c.tenant), {
		issuer: `${AUTORIDAD}/${c.tenant}/v2.0`,
		audience: c.clientId,
		clockTolerance: 60
	});
	if (payload.nonce !== o.nonce) throw new Error('El nonce del token no coincide.');
	return payload;
}

/* En un invitado, preferred_username es del tipo ana_empresa.com#EXT#@...: no sirve como correo. */
export function correoDe(p: JWTPayload): string | undefined {
	const c =
		(typeof p.email === 'string' && p.email) ||
		(typeof p.preferred_username === 'string' &&
			p.preferred_username.includes('@') &&
			!p.preferred_username.includes('#EXT#') &&
			p.preferred_username) ||
		undefined;
	return c?.toLowerCase();
}

export function urlDeCierre(c: Config, redirectUri: string) {
	return `${AUTORIDAD}/${c.tenant}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/* Solo rutas internas: nunca se redirige a un destino que venga de fuera. */
export const volverSeguro = (v: string | null) =>
	v?.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
