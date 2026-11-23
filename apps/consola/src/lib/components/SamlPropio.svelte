<!--
	Ajustes → «Sign in with your identity provider (SAML 2.0)»: ADFS, Okta, Ping,
	Keycloak, Entra ID… Se guarda pendiente y una entrada de prueba con rol admin
	lo activa (saml-propio.ts). Los roles salen de un atributo de la aserción.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { fechaCorta } from '$lib/fechas-pantalla';

	type Cert = { huella: string; caduca: string; sujeto: string } | null;
	type Estado = {
		entidad: string;
		sso: string;
		certs: string[];
		origen: string;
		spEntidad: string;
		acs: string;
		nombre: string;
		atributoRoles: string;
		atributoCorreo: string;
		roles: Partial<Record<string, string[]>>;
		exigirMfa: boolean;
		contextos: string[];
		pedirContexto: boolean;
		exigirCifrado: boolean;
		activo: boolean;
		legible: boolean;
		certificados: Cert[];
		certificadoSp: Cert;
		guardadoPor: string;
		guardado: string;
		activadoPor?: string;
		activado?: string;
	} | null;

	type Valores = {
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

	let {
		estado,
		roles,
		spEntidad,
		acs,
		error,
		valores
	}: {
		estado: Estado;
		roles: readonly string[];
		spEntidad: string;
		acs: string;
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
			'Saved. Load the service provider metadata in your identity provider, then click "Test" and sign in with an account that gets the Administrator role: that enables it.',
		activado: 'Tested and enabled: people can now sign in with your identity provider.',
		'sin-config':
			'There is nothing saved to test (or the key cannot be read on this node): save it again.',
		ida: 'The sign-in request could not be created. Try again in a few minutes.',
		caducado: 'The test took too long, or the response did not come from this test. Test again.',
		estado: 'The response does not match this browser. Test again.',
		'respuesta-estado': 'The identity provider did not allow the sign-in.',
		'respuesta-firma':
			'The SAML response was rejected: its signature, issuer, audience, time or request ID does not match. Check that both the response and the assertion are signed with the certificate saved here, and that the clocks are right.',
		'respuesta-destino':
			'The SAML response was sent to another address. Use the assertion consumer service URL shown here.',
		'respuesta-receptor':
			'The assertion is for another recipient. Use the assertion consumer service URL shown here.',
		'respuesta-cifrado':
			'The assertion is not encrypted, or it is encrypted with an algorithm the console does not support. Encrypt it with the console certificate using AES-256-GCM or AES-256-CBC and RSA-OAEP-MGF1P key transport with SHA-1 (the Keycloak default, RSA-OAEP with SHA-256, is not supported), or turn off encryption in your identity provider and stop requiring it here.',
		'respuesta-formato': 'That is not a SAML response.',
		sin_rol:
			'You signed in, but none of the values in the roles attribute is mapped to a Sugardaddy role.',
		'sin-admin': 'You signed in, but without the Administrator role. Test with an administrator.',
		sin_correo: 'The assertion has no email address (attribute or NameID).',
		idp_sin_oid:
			'The assertion does not identify the account: the NameID is missing or transient. Send a persistent NameID or the email address.',
		idp_sin_mfa:
			'You signed in, but the assertion does not show multi-factor authentication. Require MFA for this application in your identity provider, or list the AuthnContextClassRef it sends.'
	};
	const resultado = $derived(page.url.searchParams.get('saml'));
	const v = $derived<Valores>(
		valores ?? {
			entidad: estado?.entidad ?? '',
			sso: estado?.sso ?? '',
			cert: '',
			nombre: estado?.nombre ?? '',
			atributoRoles: estado?.atributoRoles ?? 'groups',
			atributoCorreo: estado?.atributoCorreo ?? '',
			roles: Object.fromEntries(roles.map((r) => [r, (estado?.roles[r] ?? []).join(', ')])),
			exigirMfa: estado?.exigirMfa ?? true,
			contextos: (estado?.contextos ?? []).join(', '),
			pedirContexto: estado?.pedirContexto ?? false,
			exigirCifrado: estado?.exigirCifrado ?? false
		}
	);
	const sp = $derived({
		entidad: estado?.spEntidad ?? spEntidad,
		acs: estado?.acs ?? acs
	});
	/* Guardado con otra dirección de la consola: el proveedor tiene la de entonces. */
	const otroOrigen = $derived(!!estado && estado.origen !== page.url.origin);
</script>

<section class="panel bloque" id="saml">
	<h2>Sign in with your identity provider (SAML 2.0)</h2>
	<p class="ayuda">
		For ADFS, Okta, Ping, Keycloak, Microsoft Entra ID, Shibboleth or any SAML 2.0 identity
		provider. Your provider checks the password and MFA, and an attribute with the person's groups
		or roles decides their role here. Local users, OIDC, Microsoft sign-in and the emergency sign-in
		keep working.
	</p>

	{#if resultado && RESULTADO[resultado]}
		<p class={resultado === 'activado' || resultado === 'guardado' ? 'bien' : 'mal'} role="status">
			{RESULTADO[resultado]}
		</p>
	{/if}

	{#if estado?.activo}
		<p class="bien">
			Enabled. Identity provider <code>{estado.entidad}</code>. Tested by {estado.activadoPor} on
			{fechaCorta(estado.activado ?? estado.guardado)}.
			{#if !estado.exigirMfa}<b>MFA from the provider is not required.</b>{/if}
		</p>
	{:else if estado}
		<p class="aviso">
			Saved but not tested: it is not in use yet. Click "Test" and sign in with an account that gets
			the Administrator role.
		</p>
	{/if}
	{#if estado && !estado.legible}
		<p class="mal">
			The service provider key cannot be read on this node: save the connection again (a new key
			will be created and you will need to load the new metadata in your identity provider).
		</p>
	{/if}
	{#if otroOrigen}
		<p class="aviso">
			This connection was saved at <code>{estado?.origen}</code>. Your identity provider sends
			people back there.
		</p>
	{/if}

	<dl class="datos">
		<dt>Service provider entity ID</dt>
		<dd><code>{sp.entidad}</code></dd>
		<dt>Assertion consumer service (HTTP-POST)</dt>
		<dd><code>{sp.acs}</code></dd>
		{#if estado}
			<dt>Service provider metadata</dt>
			<dd>
				<a class="boton" href="/auth/saml/metadata?descargar" download>Download metadata</a>
				{#if estado.certificadoSp}
					<span class="menor"
						>Certificate (signing and encryption) valid until {fechaCorta(
							estado.certificadoSp.caduca
						)}</span
					>
				{/if}
			</dd>
			<dt>Identity provider certificates</dt>
			<dd>
				<ul class="certs">
					{#each estado.certificados as c, i (i)}
						<li>
							{#if c}
								<code>{c.huella}</code>
								<span
									class="menor {Date.parse(c.caduca) < Date.now() + 30 * 86_400_000 ? 'aviso' : ''}"
									>valid until {fechaCorta(c.caduca)}</span
								>
							{:else}
								<span class="mal">Cannot be read</span>
							{/if}
						</li>
					{/each}
				</ul>
			</dd>
		{/if}
	</dl>

	<details open={!estado}>
		<summary>{estado ? 'Change the connection' : 'How to connect it'}</summary>
		<ol class="pasos">
			<li>
				Fill in the form with your identity provider's metadata and save. The console creates its
				own key and certificate.
			</li>
			<li>
				In your identity provider, add a relying party or SAML application from the service provider
				metadata (download it after saving), or by hand with the entity ID and assertion consumer
				service URL above. Sign <b>both the response and the assertion</b>, send a persistent NameID
				or the email address, an attribute with the groups or roles, and require MFA for it.
			</li>
			<li>Click "Test". It is enabled when you come back with the Administrator role.</li>
		</ol>

		{#if error}<p class="mal" role="alert">{error}</p>{/if}
		<form method="POST" action="?/samlGuardar">
			<label class="campo">
				<span>Identity provider metadata (XML)</span>
				<textarea
					name="metadatos"
					rows="5"
					spellcheck="false"
					placeholder="Paste the metadata XML, or fill in the three fields below instead"
				></textarea>
			</label>
			<fieldset class="grupo">
				<legend>Or by hand</legend>
				<label class="campo">
					<span>Identity provider entity ID</span>
					<input
						name="entidad"
						value={v.entidad}
						placeholder="http://adfs.company.com/adfs/services/trust"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				<label class="campo">
					<span>Single sign-on URL (HTTP-Redirect)</span>
					<input
						name="sso"
						value={v.sso}
						placeholder="https://adfs.company.com/adfs/ls/"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				<label class="campo">
					<span>Signing certificate (PEM; up to five, during a rollover)</span>
					<textarea
						name="cert"
						rows="3"
						spellcheck="false"
						placeholder={estado
							? 'Leave both empty to keep the saved identity provider'
							: '-----BEGIN CERTIFICATE-----'}>{v.cert}</textarea
					>
				</label>
			</fieldset>
			<label class="campo">
				<span>Button name ("Sign in with …")</span>
				<input name="nombre" value={v.nombre} maxlength="40" placeholder="ADFS" />
			</label>
			<label class="campo">
				<span>Roles attribute</span>
				<input
					name="atributoRoles"
					value={v.atributoRoles}
					spellcheck="false"
					placeholder="groups, memberOf or http://schemas.microsoft.com/ws/2008/06/identity/claims/role"
				/>
			</label>
			<label class="campo">
				<span>Email attribute (optional: the usual names and an email NameID also work)</span>
				<input name="atributoCorreo" value={v.atributoCorreo} spellcheck="false" />
			</label>
			<fieldset class="grupo">
				<legend>Which attribute values give each role (comma-separated group names or IDs)</legend>
				{#each roles as r (r)}
					<label class="campo">
						<span>{NOMBRES[r] ?? r}</span>
						<input name="rol-{r}" value={v.roles[r] ?? ''} spellcheck="false" />
					</label>
				{/each}
			</fieldset>
			<label class="marca">
				<input type="checkbox" name="exigirMfa" value="si" checked={v.exigirMfa} />
				Require MFA from the identity provider (the assertion must say so in its
				<code>AuthnContextClassRef</code>)
			</label>
			<label class="campo">
				<span
					>More accepted AuthnContextClassRef values (optional; multipleauthn and the REFEDS MFA
					profile are always accepted)</span
				>
				<input
					name="contextos"
					value={v.contextos}
					spellcheck="false"
					placeholder="e.g. urn:company:mfa"
				/>
			</label>
			<label class="marca">
				<input type="checkbox" name="pedirContexto" value="si" checked={v.pedirContexto} />
				Request these values in the sign-in request (RequestedAuthnContext)
			</label>
			<label class="marca">
				<input type="checkbox" name="exigirCifrado" value="si" checked={v.exigirCifrado} />
				Require encrypted assertions (with the console certificate in the metadata)
			</label>
			<button class="boton principal">Save</button>
		</form>
	</details>

	{#if estado}
		<div class="acciones">
			<a class="boton" data-sveltekit-reload href="/auth/saml/login?probar=1">Test</a>
			<form method="POST" action="?/samlQuitar">
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

	.menor {
		color: var(--ink-3);
		font-size: 12.5px;
		margin-left: 8px;
	}

	.datos {
		margin: 12px 0 0;
		font-size: 13.5px;
	}

	.datos dt {
		color: var(--ink-3);
		font-size: 12.5px;
		margin-top: 10px;
	}

	.datos dd {
		margin: 2px 0 0;
	}

	.certs {
		margin: 0;
		padding-left: 18px;
	}

	details {
		margin-top: 14px;
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

	.campo input,
	.campo textarea {
		width: 100%;
	}

	.campo textarea {
		font-family: var(--mono, monospace);
		font-size: 12.5px;
	}

	.grupo {
		margin: 16px 0 0;
		padding: 4px 12px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}

	.grupo legend {
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
