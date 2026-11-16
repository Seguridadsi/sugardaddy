<!--
	Ajustes → «Sign in with your identity provider (OIDC)»: Okta, Ping, ADFS,
	Keycloak… Se guarda pendiente y una entrada de prueba con rol admin lo
	activa (oidc-propio.ts). Los roles salen de una claim del token.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { fechaCorta } from '$lib/fechas-pantalla';

	type Estado = {
		emisor: string;
		clientId: string;
		final: string | null;
		nombre: string;
		alcances: string;
		claim: string;
		roles: Partial<Record<string, string[]>>;
		exigirMfa: boolean;
		acr: string[];
		activo: boolean;
		legible: boolean;
		guardadoPor: string;
		guardado: string;
		activadoPor?: string;
		activado?: string;
	} | null;

	type Valores = {
		emisor: string;
		clientId: string;
		nombre: string;
		alcances: string;
		claim: string;
		roles: Record<string, string>;
		exigirMfa: boolean;
		acr: string;
	};

	let {
		estado,
		roles,
		retorno,
		error,
		valores
	}: {
		estado: Estado;
		roles: readonly string[];
		retorno: string;
		error?: string;
		valores?: Valores;
	} = $props();

	const NOMBRES: Record<string, string> = {
		lector: 'Viewer',
		operador: 'Operator',
		aprobador: 'Approver',
		'admin-listas': 'List administrator',
		admin: 'Administrator'
	};

	const RESULTADO: Record<string, string> = {
		guardado:
			'Saved. Now click "Test" and sign in with an account that gets the Administrator role: that enables it.',
		activado: 'Tested and enabled: people can now sign in with your identity provider.',
		'sin-config': 'There is nothing saved to test (or the secret cannot be read): save it again.',
		descubrimiento:
			'The identity provider could not be reached from the node. Check the issuer address and outbound access.',
		rechazado: 'The identity provider did not allow the sign-in.',
		estado: 'The response does not match this test. Test again.',
		caducado: 'The test took too long. Test again.',
		canje:
			'The identity provider did not accept the code exchange. Check the client secret and the redirect URL.',
		sin_rol:
			'You signed in, but none of the values in the roles claim is mapped to a Sugardaddy role.',
		'sin-admin': 'You signed in, but without the Administrator role. Test with an administrator.',
		sin_correo: 'The token has no email address (email, preferred_username or upn).',
		idp_sin_oid: 'The token does not identify the account (no "sub").',
		idp_sin_mfa:
			'You signed in, but the token does not show multi-factor authentication. Require MFA for this application in your identity provider, or list the acr value it sends.'
	};
	const resultado = $derived(page.url.searchParams.get('oidc'));
	const v = $derived<Valores>(
		valores ?? {
			emisor: estado?.emisor ?? '',
			clientId: estado?.clientId ?? '',
			nombre: estado?.nombre ?? '',
			alcances: estado?.alcances ?? 'profile email',
			claim: estado?.claim ?? 'groups',
			roles: Object.fromEntries(roles.map((r) => [r, (estado?.roles[r] ?? []).join(', ')])),
			exigirMfa: estado?.exigirMfa ?? true,
			acr: (estado?.acr ?? []).join(', ')
		}
	);
</script>

<section class="panel bloque" id="oidc">
	<h2>Sign in with your identity provider (OIDC)</h2>
	<p class="ayuda">
		For Okta, Ping, ADFS, Keycloak, Auth0, Google Workspace or any OpenID Connect provider. Your
		provider checks the password and MFA, and its groups or roles decide each person's role here.
		Local users, Microsoft sign-in and the emergency sign-in keep working.
	</p>

	{#if resultado && RESULTADO[resultado]}
		<p class={resultado === 'activado' || resultado === 'guardado' ? 'bien' : 'mal'} role="status">
			{RESULTADO[resultado]}
		</p>
	{/if}

	{#if estado?.activo}
		<p class="bien">
			Enabled. Issuer <code>{estado.emisor}</code>, client
			<code>{estado.clientId}</code>{#if estado.final}, secret ending in <code>{estado.final}</code
				>{/if}. Tested by
			{estado.activadoPor} on {fechaCorta(estado.activado ?? estado.guardado)}.
			{#if !estado.exigirMfa}<b>MFA from the provider is not required.</b>{/if}
		</p>
		{#if !estado.legible}
			<p class="mal">The saved secret cannot be read on this node: enter it again below.</p>
		{/if}
	{:else if estado}
		<p class="aviso">
			Saved but not tested: it is not in use yet. Click "Test" and sign in with an account that gets
			the Administrator role.
		</p>
	{/if}

	<details open={!estado}>
		<summary>{estado ? 'Change the connection' : 'How to connect it'}</summary>
		<ol class="pasos">
			<li>
				In your identity provider, create a <b>web application</b> (confidential client,
				authorization code flow with PKCE) with this redirect URL: <code>{retorno}</code>
			</li>
			<li>
				Make it send the person's groups or roles in the ID token (for example the
				<code>groups</code> claim) and require MFA for it.
			</li>
			<li>
				Fill in the form, save, and click "Test". It is enabled when you come back with the
				Administrator role.
			</li>
		</ol>

		{#if error}<p class="mal" role="alert">{error}</p>{/if}
		<form method="POST" action="?/oidcGuardar">
			<label class="campo">
				<span>Issuer</span>
				<input
					name="emisor"
					value={v.emisor}
					placeholder="https://company.okta.com"
					autocomplete="off"
					spellcheck="false"
					required
				/>
			</label>
			<label class="campo">
				<span>Client ID</span>
				<input name="clientId" value={v.clientId} autocomplete="off" spellcheck="false" required />
			</label>
			<label class="campo">
				<span>Client secret</span>
				<input
					name="secreto"
					type="password"
					autocomplete="off"
					placeholder={estado ? 'Leave empty to keep the current one' : ''}
					required={!estado}
				/>
			</label>
			<label class="campo">
				<span>Button name ("Sign in with …")</span>
				<input name="nombre" value={v.nombre} maxlength="40" placeholder="Okta" />
			</label>
			<label class="campo">
				<span>Scopes (besides openid)</span>
				<input name="alcances" value={v.alcances} spellcheck="false" />
			</label>
			<label class="campo">
				<span>Roles claim</span>
				<input name="claim" value={v.claim} spellcheck="false" placeholder="groups" />
			</label>
			<fieldset class="roles">
				<legend>Which claim values give each role (comma-separated group names or IDs)</legend>
				{#each roles as r (r)}
					<label class="campo">
						<span>{NOMBRES[r] ?? r}</span>
						<input name="rol-{r}" value={v.roles[r] ?? ''} spellcheck="false" />
					</label>
				{/each}
			</fieldset>
			<label class="marca">
				<input type="checkbox" name="exigirMfa" value="si" checked={v.exigirMfa} />
				Require MFA from the identity provider (the token must say so in <code>amr</code> or
				<code>acr</code>)
			</label>
			<label class="campo">
				<span>Accepted acr values (optional)</span>
				<input
					name="acr"
					value={v.acr}
					spellcheck="false"
					placeholder="e.g. 2, or urn:company:mfa"
				/>
			</label>
			<button class="boton principal">Save</button>
		</form>
	</details>

	{#if estado}
		<div class="acciones">
			<a class="boton" data-sveltekit-reload href="/auth/oidc/login?probar=1">Test</a>
			<form method="POST" action="?/oidcQuitar">
				<button class="boton peligro">Remove</button>
			</form>
		</div>
	{/if}
</section>

<style>
	.bloque {
		margin-bottom: 16px;
		padding: 18px 20px 20px;
		max-width: 760px;
	}

	h2 {
		font-size: 16px;
		font-weight: 600;
	}

	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 8px 0 4px;
	}

	.bien {
		color: var(--ok);
	}

	.mal {
		color: var(--crit);
	}

	.aviso {
		color: var(--warn);
	}

	details {
		margin-top: 12px;
	}

	summary {
		cursor: pointer;
		font-weight: 600;
		font-size: 14px;
	}

	.pasos {
		margin: 10px 0 0;
		padding-left: 20px;
		font-size: 14px;
	}

	.pasos li {
		margin-bottom: 10px;
	}

	code {
		overflow-wrap: anywhere;
	}

	.campo {
		display: block;
		margin: 14px 0 0;
	}

	.campo span {
		display: block;
		font-size: 12.5px;
		color: var(--ink-3);
		margin-bottom: 4px;
	}

	.campo input {
		width: 100%;
	}

	.roles {
		margin: 16px 0 0;
		padding: 4px 12px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}

	.roles legend {
		font-size: 12.5px;
		color: var(--ink-3);
		padding: 0 4px;
	}

	.marca {
		display: flex;
		gap: 8px;
		align-items: baseline;
		margin-top: 16px;
		font-size: 13.5px;
	}

	form .boton {
		margin-top: 16px;
	}

	.acciones {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-top: 16px;
	}

	.acciones form .boton {
		margin-top: 0;
	}
</style>
