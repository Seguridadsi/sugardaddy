/*
 * OIDC genérico (@sugardaddy/entra/oidc): descubrimiento, la URL de ida y el
 * canje con un id_token firmado de verdad (claves generadas aquí, el proveedor
 * es un fetch falso), y cómo se lee la MFA, el correo y los grupos del token.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
	_olvidarDescubrimientos,
	canjearOidc,
	correoOidc,
	descubrir,
	huboMfa,
	urlDeAutorizacionOidc,
	urlSegura,
	valoresClaim,
	type ConfigOidc,
	type Descubrimiento
} from '@sugardaddy/entra/oidc';

const EMISOR = 'https://idp.example.com/realms/banco';
const D: Descubrimiento = {
	issuer: EMISOR,
	authorization_endpoint: `${EMISOR}/protocol/openid-connect/auth?kc=1`,
	token_endpoint: `${EMISOR}/protocol/openid-connect/token`,
	jwks_uri: `${EMISOR}/protocol/openid-connect/certs`
};
const C: ConfigOidc = { emisor: EMISOR, clientId: 'sugardaddy', secret: 's3cr3t' };

const respuesta = (cuerpo: unknown, status = 200) =>
	new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
	vi.unstubAllGlobals();
	_olvidarDescubrimientos();
});

describe('descubrimiento', () => {
	it('lee la configuración y comprueba que el emisor casa', async () => {
		const f = vi.fn(async () => respuesta(D));
		expect((await descubrir(`${EMISOR}/`, f as never)).token_endpoint).toBe(D.token_endpoint);
		expect(f).toHaveBeenCalledWith(`${EMISOR}/.well-known/openid-configuration`, expect.anything());
		/* Una hora en memoria. */
		await descubrir(EMISOR, f as never);
		expect(f).toHaveBeenCalledTimes(1);
	});

	it('rechaza un emisor distinto, puntos sin https y direcciones sin https', async () => {
		await expect(
			descubrir(EMISOR, (async () => respuesta({ ...D, issuer: 'https://otro.example' })) as never)
		).rejects.toThrow(/issuer/);
		_olvidarDescubrimientos();
		await expect(
			descubrir(EMISOR, (async () =>
				respuesta({ ...D, token_endpoint: 'http://idp.example.com/t' })) as never)
		).rejects.toThrow(/token_endpoint/);
		await expect(descubrir('http://idp.example.com', fetch)).rejects.toThrow(/https/);
		expect(urlSegura('https://user:pw@idp.example.com')).toBe(false);
		expect(urlSegura('http://localhost:8080/realms/x')).toBe(true);
	});
});

describe('ida al proveedor', () => {
	it('código con PKCE S256, nonce, estado y los parámetros que ya traía el punto', async () => {
		const u = new URL(
			await urlDeAutorizacionOidc({ ...C, acr: ['gold'] }, D, {
				redirectUri: 'https://consola.example/auth/oidc/callback',
				estado: 'E',
				nonce: 'N',
				verificador: 'V'.repeat(43)
			})
		);
		expect(u.searchParams.get('kc')).toBe('1');
		expect(u.searchParams.get('response_type')).toBe('code');
		expect(u.searchParams.get('code_challenge_method')).toBe('S256');
		expect(u.searchParams.get('scope')).toBe('openid profile email');
		expect(u.searchParams.get('acr_values')).toBe('gold');
		expect(u.searchParams.get('state')).toBe('E');
		expect(u.searchParams.get('nonce')).toBe('N');
	});
});

describe('canje del código', async () => {
	const { publicKey, privateKey } = await generateKeyPair('RS256');
	const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
	const firmar = (p: Record<string, unknown>, o: { iss?: string; aud?: string | string[] } = {}) =>
		new SignJWT(p)
			.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
			.setIssuer(o.iss ?? EMISOR)
			.setAudience(o.aud ?? 'sugardaddy')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);

	/* El proveedor: el punto de token (fetch pasado) y sus claves (fetch global, lo usa jose). */
	function proveedor(idToken: string, metodos?: string[]) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => respuesta({ keys: [jwk] }))
		);
		const token = vi.fn(async (_u: string, _i: RequestInit) => respuesta({ id_token: idToken }));
		return { d: { ...D, token_endpoint_auth_methods_supported: metodos }, token };
	}
	const o = {
		codigo: 'c',
		redirectUri: 'https://consola.example/cb',
		verificador: 'v',
		nonce: 'n1'
	};

	it('verifica firma, emisor, audiencia y nonce; secreto por Basic de serie', async () => {
		const { d, token } = proveedor(await firmar({ sub: 'u1', nonce: 'n1', amr: ['pwd', 'otp'] }));
		const p = await canjearOidc(C, d, o, token as never);
		expect(p.sub).toBe('u1');
		const init = token.mock.calls[0][1];
		expect((init.headers as Record<string, string>).authorization).toBe(
			`Basic ${Buffer.from('sugardaddy:s3cr3t').toString('base64')}`
		);
		expect(String(init.body)).toContain('code_verifier=v');
		expect(String(init.body)).not.toContain('s3cr3t');
	});

	it('client_secret_post solo si el proveedor no admite Basic', async () => {
		const { d, token } = proveedor(await firmar({ sub: 'u1', nonce: 'n1' }), [
			'client_secret_post'
		]);
		await canjearOidc(C, d, o, token as never);
		expect(String(token.mock.calls[0][1].body)).toContain('client_secret=s3cr3t');
	});

	it('rechaza otro nonce, otro emisor, otra audiencia y un azp ajeno', async () => {
		for (const [p, op] of [
			[{ sub: 'u', nonce: 'otro' }, {}],
			[{ sub: 'u', nonce: 'n1' }, { iss: 'https://malo.example' }],
			[{ sub: 'u', nonce: 'n1' }, { aud: 'otro-cliente' }],
			[{ sub: 'u', nonce: 'n1', azp: 'otro' }, { aud: ['sugardaddy', 'otro'] }]
		] as const) {
			const { d, token } = proveedor(await firmar({ ...p }, op as never));
			await expect(canjearOidc(C, d, o, token as never)).rejects.toThrow();
		}
	});

	it('un token firmado con HS256 (el secreto del cliente) no vale', async () => {
		const hs = await new SignJWT({ sub: 'u', nonce: 'n1' })
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer(EMISOR)
			.setAudience('sugardaddy')
			.setExpirationTime('5m')
			.sign(new TextEncoder().encode('s3cr3t'.padEnd(32, 'x')));
		const { d, token } = proveedor(hs);
		await expect(canjearOidc(C, d, o, token as never)).rejects.toThrow();
	});
});

describe('lo que se lee del token', () => {
	it('MFA: amr con mfa, dos tipos de factor, la URI de ADFS o un acr aceptado', () => {
		expect(huboMfa({ amr: ['mfa'] })).toBe(true);
		expect(huboMfa({ amr: ['pwd', 'otp'] })).toBe(true);
		expect(huboMfa({ amr: ['pwd', 'hwk'] })).toBe(true);
		expect(huboMfa({ amr: ['http://schemas.microsoft.com/claims/multipleauthn'] })).toBe(true);
		expect(huboMfa({ amr: ['pwd'] })).toBe(false);
		expect(huboMfa({ amr: ['otp', 'sms'] })).toBe(false);
		expect(huboMfa({})).toBe(false);
		expect(huboMfa({ acr: '2' }, ['2'])).toBe(true);
		expect(huboMfa({ acr: '1' }, ['2'])).toBe(false);
	});

	it('correo: email, o preferred_username / upn con forma de correo', () => {
		expect(correoOidc({ email: 'Ana@Banco.es' })).toBe('ana@banco.es');
		expect(correoOidc({ preferred_username: 'ana', upn: 'ana@banco.es' })).toBe('ana@banco.es');
		expect(correoOidc({ preferred_username: 'ana' })).toBeUndefined();
	});

	it('grupos: lista, texto o ruta con puntos (Keycloak)', () => {
		expect(valoresClaim({ groups: ['a', 'b', 3] }, 'groups')).toEqual(['a', 'b']);
		expect(valoresClaim({ roles: 'a b,c' }, 'roles')).toEqual(['a', 'b', 'c']);
		expect(valoresClaim({ realm_access: { roles: ['sd-admin'] } }, 'realm_access.roles')).toEqual([
			'sd-admin'
		]);
		expect(valoresClaim({}, 'groups')).toEqual([]);
	});
});
