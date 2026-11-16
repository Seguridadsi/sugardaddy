<!--
	Ajustes → «Entrar con Microsoft»: el cliente conecta la consola con SU
	Entra ID. Le damos la URL de retorno y un script para Cloud Shell que crea
	el registro de la aplicación; él pega aquí lo que imprime, y una entrada de
	prueba con Microsoft lo activa (entra-propio.ts).
-->
<script lang="ts">
	import { page } from '$app/state';
	import { fechaCorta } from '$lib/fechas-pantalla';
	import { ROLES } from '$lib/permisos';

	type Estado = {
		tenant: string;
		clientId: string;
		final: string | null;
		activo: boolean;
		legible: boolean;
		guardadoPor: string;
		guardado: string;
		activadoPor?: string;
		activado?: string;
		exigirMfa: boolean;
		modoMfa: 'exigida' | 'apagada' | 'heredada';
		contextoAuth: string | null;
	} | null;

	let {
		propio,
		seguridadsi,
		b2b,
		retorno,
		error,
		valores
	}: {
		propio: Estado;
		seguridadsi: boolean;
		/* En qué punto está la salida del Entra de SeguridadSI (b2b.ts). */
		b2b: 'no' | 'activo' | 'retirado';
		retorno: string;
		error?: string;
		valores?: { tenant: string; clientId: string; exigirMfa?: boolean; contextoAuth?: string };
	} = $props();

	const RESULTADO: Record<string, string> = {
		activado: 'Tested and enabled: from now on, people sign in with your Microsoft account.',
		'sin-config': 'There is nothing saved to test (or the secret cannot be read): save it again.',
		rechazado:
			'Microsoft did not allow the sign-in. Check that your user has a role assigned in the application.',
		estado: 'The Microsoft response does not match this test. Test again.',
		caducado: 'The test took too long. Test again.',
		canje: 'Microsoft did not accept the secret or the redirect URL. Check both.',
		sin_rol:
			'You signed in, but without any Sugardaddy role: assign yourself the "admin" role in the application.',
		'sin-admin':
			'You signed in, but without the "admin" role. To enable it, the test must be done by someone with "admin".',
		sin_correo: 'Your Microsoft account has no email address.',
		sin_oid: 'The Microsoft token does not identify the account.',
		'mfa-activada':
			'MFA enforcement is on: from now on, Microsoft sign-ins without MFA are refused.',
		contexto: 'The authentication context ID is c1 to c99.',
		sin_mfa:
			'You signed in, but the token does not show multi-factor authentication. Create an authentication context in Entra ID (Conditional Access > Authentication contexts, e.g. c1), a Conditional Access policy for it that requires MFA, and enter its ID below.'
	};
	let exigirMfa = $state(true);
	$effect.pre(() => {
		exigirMfa = valores?.exigirMfa ?? propio?.modoMfa !== 'apagada';
	});
	const resultado = $derived(page.url.searchParams.get('entra'));

	const NOMBRES: Record<string, string> = {
		credenciales:
			'Credential viewer: reveals captured credentials (audited); add it to another role',
		lector: 'Viewer: sees everything, changes nothing',
		operador: 'Operator: deploys and stops honeypots',
		aprobador: 'Approver: approves blocks',
		'admin-listas': 'List administrator',
		admin: 'Administrator: everything, including settings'
	};
	/*
	 * Los roles de la consola y el de soporte: con él, la persona de soporte que el
	 * cliente invite a su tenant entra solo mientras tenga abierto el acceso
	 * (auth/entra.ts, identidadPropia). `idp` y `acct` dicen de dónde viene un invitado.
	 */
	const roles = $derived(
		JSON.stringify([
			...ROLES.map((r) => ({
				allowedMemberTypes: ['User'],
				description: NOMBRES[r],
				displayName: NOMBRES[r].split(':')[0],
				id: '@@',
				isEnabled: true,
				value: r
			})),
			{
				allowedMemberTypes: ['User'],
				description: `${page.data.operador} support, only while support access is open`.replace(
					/['"\\]/g,
					''
				),
				displayName: `${page.data.operador} support`.replace(/['"\\]/g, ''),
				id: '@@',
				isEnabled: true,
				value: 'soporte'
			}
		])
	);

	/* Para Azure Cloud Shell (bash): todo lo que hace falta en el tenant del cliente. */
	const script = $derived(`RETORNO='${retorno}'
ROLES='${roles}'
ROLES=$(python3 -c 'import json,sys,uuid;r=json.loads(sys.argv[1]);[x.update(id=str(uuid.uuid4())) for x in r];print(json.dumps(r))' "$ROLES")
APP=$(az ad app create --display-name 'Sugardaddy consola' --sign-in-audience AzureADMyOrg \\
  --web-redirect-uris "$RETORNO" --app-roles "$ROLES" \\
  --optional-claims '{"idToken":[{"name":"email","essential":false},{"name":"idp","essential":false},{"name":"acct","essential":false}]}' --query appId -o tsv)
SP=$(az ad sp create --id "$APP" --query id -o tsv)
az ad sp update --id "$SP" --set appRoleAssignmentRequired=true
ADMIN=$(az ad app show --id "$APP" --query "appRoles[?value=='admin'].id" -o tsv)
YO=$(az ad signed-in-user show --query id -o tsv)
az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP/appRoleAssignedTo" \\
  --body "{\\"principalId\\":\\"$YO\\",\\"resourceId\\":\\"$SP\\",\\"appRoleId\\":\\"$ADMIN\\"}" -o none
SECRETO=$(az ad app credential reset --id "$APP" --display-name sugardaddy --years 2 --query password -o tsv)
echo; echo "Tenant:    $(az account show --query tenantId -o tsv)"
echo "Client:    $APP"; echo "Secret:    $SECRETO"`);

	let copiado = $state(false);
	async function copiar() {
		await navigator.clipboard.writeText(script);
		copiado = true;
		setTimeout(() => (copiado = false), 2000);
	}
</script>

<section class="panel bloque" id="entra">
	<h2>Sign in with Microsoft (your Entra ID)</h2>
	<p class="ayuda">
		So your team can sign in with their company Microsoft account, including MFA. It connects to
		your organization's Entra ID: you create the application yourself, in your tenant, and you
		decide who signs in and with which role by assigning roles in it. The console username and
		password and the emergency sign-in keep working.
	</p>

	{#if resultado && RESULTADO[resultado]}
		<p
			class={resultado === 'activado' || resultado === 'mfa-activada' ? 'bien' : 'mal'}
			role="status"
		>
			{RESULTADO[resultado]}
		</p>
	{/if}

	{#if propio?.activo}
		<p class="bien">
			Enabled. Tenant <code>{propio.tenant}</code>, application
			<code>{propio.clientId}</code>{#if propio.final}, secret ending in <code>{propio.final}</code
				>{/if}. Tested by {propio.activadoPor} on
			{fechaCorta(propio.activado ?? propio.guardado)}.
			{#if propio.exigirMfa}
				MFA required{#if propio.contextoAuth}
					(authentication context <code>{propio.contextoAuth}</code>){/if}.
			{/if}
		</p>
		{#if propio.modoMfa === 'heredada'}
			<div class="aviso" id="entra-mfa">
				<p>
					<b>Your Microsoft sign-in does not require MFA.</b> This connection was set up before MFA was
					enforced: sign-ins without MFA still get in, and each one is recorded in the audit log. In Entra
					ID, create an authentication context (Conditional Access → Authentication contexts, e.g. c1)
					and a Conditional Access policy that targets it and requires MFA. Then turn on enforcement:
					you sign in once with Microsoft, and it is saved only if the token shows MFA.
				</p>
				<form method="GET" action="/auth/login" data-sveltekit-reload>
					<input type="hidden" name="probar" value="1" />
					<input type="hidden" name="activarMfa" value="1" />
					<label class="campo">
						<span>Authentication context ID (recommended)</span>
						<input
							name="contexto"
							value={propio.contextoAuth ?? ''}
							placeholder="c1"
							autocomplete="off"
							spellcheck="false"
							pattern="[cC][1-9][0-9]?"
						/>
					</label>
					<button class="boton principal">Turn on enforcement</button>
				</form>
			</div>
		{:else if !propio.exigirMfa}
			<p class="aviso">
				<b>MFA from Microsoft is not required.</b> Anyone with a password and a role in the application
				signs in.
			</p>
		{/if}
		{#if !propio.legible}
			<p class="mal">The saved secret cannot be read on this node: enter it again below.</p>
		{/if}
	{:else if propio}
		<p class="aviso">
			Saved but not tested: it is not in use yet. Click "Test" and sign in with an account that has
			the "admin" role in the application.
		</p>
	{:else if seguridadsi && b2b === 'activo'}
		<p class="aviso">
			Today this console signs in with Microsoft through the {page.data.operador} Entra ID. Connect your
			own: from then on only your organization decides who signs in, and {page.data.operador} support
			signs in as a guest you invite. <a href="#migrar">How to move without losing access</a>
		</p>
	{/if}

	<details open={!propio}>
		<summary>{propio ? 'Change the connection' : 'How to connect it (about 5 minutes)'}</summary>
		<ol class="pasos">
			<li>
				Go to <a href="https://shell.azure.com" target="_blank" rel="noopener">shell.azure.com</a>
				(Bash) with an account that can create applications in your Entra ID.
			</li>
			<li>
				Paste this script. It creates the "Sugardaddy consola" application with this redirect URL: <code
					>{retorno}</code
				>, its roles and mandatory assignment, gives you the "admin" role and generates a secret
				that expires in 2 years.
				<pre>{script}</pre>
				<button type="button" class="boton" onclick={copiar}>
					{copiado ? 'Copied' : 'Copy the script'}
				</button>
			</li>
			<li>
				Copy what it prints at the end here and click "Save and test": it takes you to Microsoft
				and, if you come back with the "admin" role, it is enabled.
			</li>
		</ol>
		<p class="ayuda">
			The redirect URL is this console's address exactly as you are using it now. If your team signs
			in through a different name, use that same name before connecting it.
		</p>

		{#if error}<p class="mal" role="alert">{error}</p>{/if}
		<!-- Sin use:enhance: si va bien, la respuesta lleva al navegador hasta Microsoft. -->
		<form method="POST" action="?/entraGuardar">
			<label class="campo">
				<span>Tenant (directory ID)</span>
				<input
					name="tenant"
					value={valores?.tenant ?? propio?.tenant ?? ''}
					placeholder="00000000-0000-0000-0000-000000000000"
					autocomplete="off"
					spellcheck="false"
					required
				/>
			</label>
			<label class="campo">
				<span>Client (application ID)</span>
				<input
					name="clientId"
					value={valores?.clientId ?? propio?.clientId ?? ''}
					placeholder="00000000-0000-0000-0000-000000000000"
					autocomplete="off"
					spellcheck="false"
					required
				/>
			</label>
			<label class="campo">
				<span>Secret</span>
				<input
					name="secreto"
					type="password"
					autocomplete="off"
					placeholder={propio ? 'Leave empty to keep the current one' : ''}
					required={!propio}
				/>
			</label>
			<label class="campo">
				<span>Conditional Access authentication context ID (recommended)</span>
				<input
					name="contextoAuth"
					value={valores?.contextoAuth ?? propio?.contextoAuth ?? ''}
					placeholder="c1"
					autocomplete="off"
					spellcheck="false"
					pattern="[cC][1-9][0-9]?"
				/>
			</label>
			<p class="ayuda">
				In Entra ID, create an authentication context (Conditional Access → Authentication
				contexts), and a Conditional Access policy that targets it and requires MFA. The console
				asks Microsoft for it at every sign-in and only accepts tokens that show it was met.
			</p>
			<label class="marca">
				<input type="checkbox" name="exigirMfa" value="si" bind:checked={exigirMfa} />
				Require MFA from Microsoft (the token must show it)
			</label>
			{#if !exigirMfa}
				<label class="marca aviso">
					<input type="checkbox" name="confirmarSinMfa" value="si" required />
					I confirm that this console will accept Microsoft sign-ins without MFA. This is recorded in
					the audit log.
				</label>
			{/if}
			<button class="boton principal">Save and test</button>
		</form>
	</details>

	{#if propio}
		<div class="acciones-entra">
			<a class="boton" href="/auth/login?probar=1">Test</a>
			<form method="POST" action="?/entraQuitar">
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

	pre {
		margin: 8px 0;
		padding: 10px 12px;
		max-height: 220px;
		overflow: auto;
		font-size: 12px;
		background: var(--surface-2);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		white-space: pre;
	}

	code {
		overflow-wrap: anywhere;
	}

	.campo {
		margin: 14px 0 0;
	}

	.marca {
		display: flex;
		gap: 8px;
		align-items: baseline;
		margin-top: 12px;
		font-size: 14px;
	}

	form .boton {
		margin-top: 16px;
	}

	.acciones-entra {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-top: 16px;
	}

	.acciones-entra form .boton {
		margin-top: 0;
	}
</style>
