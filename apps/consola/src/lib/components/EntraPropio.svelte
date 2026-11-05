<!--
	Ajustes → «Entrar con Microsoft»: el cliente conecta la consola con SU
	Entra ID. Le damos la URL de retorno y un script para Cloud Shell que crea
	el registro de la aplicación; él pega aquí lo que imprime, y una entrada de
	prueba con Microsoft lo activa (entra-propio.ts).
-->
<script lang="ts">
	import { page } from '$app/state';
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
	} | null;

	let {
		propio,
		seguridadsi,
		retorno,
		error,
		valores
	}: {
		propio: Estado;
		seguridadsi: boolean;
		retorno: string;
		error?: string;
		valores?: { tenant: string; clientId: string };
	} = $props();

	const RESULTADO: Record<string, string> = {
		activado: 'Probado y activado: a partir de ahora se entra con tu Microsoft.',
		'sin-config':
			'No hay nada guardado que probar (o el secreto no se puede leer): vuelve a guardarlo.',
		rechazado:
			'Microsoft no ha dejado entrar. Mira que tu usuario tenga asignado un rol en la aplicación.',
		estado: 'La respuesta de Microsoft no corresponde a esta prueba. Vuelve a probar.',
		caducado: 'La prueba ha tardado demasiado. Vuelve a probar.',
		canje: 'Microsoft no ha aceptado el secreto o la URL de retorno. Revisa los dos.',
		sin_rol:
			'Has entrado, pero sin ningún rol de Sugardaddy: asígnate el rol «admin» en la aplicación.',
		'sin-admin':
			'Has entrado, pero sin el rol «admin». Para activarlo, la prueba la hace alguien con «admin».',
		sin_correo: 'Tu cuenta de Microsoft no trae dirección de correo.',
		sin_oid: 'El token de Microsoft no identifica la cuenta.'
	};
	const resultado = $derived(page.url.searchParams.get('entra'));

	const NOMBRES: Record<string, string> = {
		lector: 'Lector: ve todo, no cambia nada',
		operador: 'Operador: despliega y para trampas',
		aprobador: 'Aprobador: aprueba bloqueos',
		'admin-listas': 'Administrador de listas',
		admin: 'Administrador: todo, incluidos los ajustes'
	};
	const roles = JSON.stringify(
		ROLES.map((r) => ({
			allowedMemberTypes: ['User'],
			description: NOMBRES[r],
			displayName: NOMBRES[r].split(':')[0],
			id: '@@',
			isEnabled: true,
			value: r
		}))
	);

	/* Para Azure Cloud Shell (bash): todo lo que hace falta en el tenant del cliente. */
	const script = $derived(`RETORNO='${retorno}'
ROLES='${roles}'
ROLES=$(python3 -c 'import json,sys,uuid;r=json.loads(sys.argv[1]);[x.update(id=str(uuid.uuid4())) for x in r];print(json.dumps(r))' "$ROLES")
APP=$(az ad app create --display-name 'Sugardaddy consola' --sign-in-audience AzureADMyOrg \\
  --web-redirect-uris "$RETORNO" --app-roles "$ROLES" \\
  --optional-claims '{"idToken":[{"name":"email","essential":false}]}' --query appId -o tsv)
SP=$(az ad sp create --id "$APP" --query id -o tsv)
az ad sp update --id "$SP" --set appRoleAssignmentRequired=true
ADMIN=$(az ad app show --id "$APP" --query "appRoles[?value=='admin'].id" -o tsv)
YO=$(az ad signed-in-user show --query id -o tsv)
az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP/appRoleAssignedTo" \\
  --body "{\\"principalId\\":\\"$YO\\",\\"resourceId\\":\\"$SP\\",\\"appRoleId\\":\\"$ADMIN\\"}" -o none
SECRETO=$(az ad app credential reset --id "$APP" --display-name sugardaddy --years 2 --query password -o tsv)
echo; echo "Tenant:    $(az account show --query tenantId -o tsv)"
echo "Cliente:   $APP"; echo "Secreto:   $SECRETO"`);

	let copiado = $state(false);
	async function copiar() {
		await navigator.clipboard.writeText(script);
		copiado = true;
		setTimeout(() => (copiado = false), 2000);
	}
</script>

<section class="panel bloque" id="entra">
	<h2>Entrar con Microsoft (tu Entra ID)</h2>
	<p class="ayuda">
		Para que tu equipo entre con su cuenta de Microsoft de la empresa, con su MFA. Se conecta con el
		Entra ID de tu organización: la aplicación la creas tú, en tu tenant, y quién entra y con qué
		rol lo decides tú asignando roles en ella. El usuario y contraseña de la consola y la entrada de
		emergencia siguen valiendo.
	</p>

	{#if resultado && RESULTADO[resultado]}
		<p class={resultado === 'activado' ? 'bien' : 'mal'} role="status">
			{RESULTADO[resultado]}
		</p>
	{/if}

	{#if propio?.activo}
		<p class="bien">
			Activo. Tenant <code>{propio.tenant}</code>, aplicación
			<code>{propio.clientId}</code>{#if propio.final}, secreto acabado en <code
					>{propio.final}</code
				>{/if}. Probado por {propio.activadoPor} el
			{new Date(propio.activado ?? propio.guardado).toLocaleDateString('es-ES')}.
		</p>
		{#if !propio.legible}
			<p class="mal">El secreto guardado no se puede leer en este nodo: vuelve a ponerlo abajo.</p>
		{/if}
	{:else if propio}
		<p class="aviso">
			Guardado pero sin probar: aún no se usa. Pulsa «Probar» y entra con una cuenta que tenga el
			rol «admin» en la aplicación.
		</p>
	{:else if seguridadsi}
		<p>
			Hoy esta consola entra con Microsoft a través del Entra de {page.data.operador}. Si conectas
			el tuyo, pasa a usarse el tuyo (y el acceso de soporte de {page.data.operador} ya no entra con Microsoft).
		</p>
	{/if}

	<details open={!propio}>
		<summary>{propio ? 'Cambiar la conexión' : 'Cómo conectarlo (unos 5 minutos)'}</summary>
		<ol class="pasos">
			<li>
				Entra en <a href="https://shell.azure.com" target="_blank" rel="noopener">shell.azure.com</a
				>
				(Bash) con una cuenta que pueda crear aplicaciones en tu Entra ID.
			</li>
			<li>
				Pega este script. Crea la aplicación «Sugardaddy consola» con esta URL de retorno:
				<code>{retorno}</code>, sus roles y la asignación obligatoria, te da a ti el rol «admin» y
				saca un secreto que caduca en 2 años.
				<pre>{script}</pre>
				<button type="button" class="boton" onclick={copiar}>
					{copiado ? 'Copiado' : 'Copiar el script'}
				</button>
			</li>
			<li>
				Copia lo que imprime al final aquí y pulsa «Guardar y probar»: te lleva a Microsoft y, si
				vuelves con el rol «admin», queda activado.
			</li>
		</ol>
		<p class="ayuda">
			La URL de retorno es la de esta consola tal y como la estás usando ahora. Si tu equipo entra
			por otro nombre, entra tú por ese mismo nombre antes de conectarlo.
		</p>

		{#if error}<p class="mal" role="alert">{error}</p>{/if}
		<!-- Sin use:enhance: si va bien, la respuesta lleva al navegador hasta Microsoft. -->
		<form method="POST" action="?/entraGuardar">
			<label class="campo">
				<span>Tenant (id del directorio)</span>
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
				<span>Cliente (id de la aplicación)</span>
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
				<span>Secreto</span>
				<input
					name="secreto"
					type="password"
					autocomplete="off"
					placeholder={propio ? 'Déjalo vacío para conservar el que hay' : ''}
					required={!propio}
				/>
			</label>
			<button class="boton principal">Guardar y probar</button>
		</form>
	</details>

	{#if propio}
		<div class="acciones-entra">
			<a class="boton" href="/auth/login?probar=1">Probar</a>
			<form method="POST" action="?/entraQuitar">
				<button class="boton peligro">Quitar</button>
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
