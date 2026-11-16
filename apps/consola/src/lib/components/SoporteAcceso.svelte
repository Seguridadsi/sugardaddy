<!--
	Ajustes → acceso de soporte. El cliente acepta (rol y plazo, como mucho 30
	días; 4 horas sin renovar en la postura bancaria), renueva, rechaza o cierra.
	Lo que hace el soporte dentro se ve en Audit logs → Support sessions. Con su propio Entra, además, le damos el
	script para invitar en SU tenant a la persona que lo pidió y darle el rol
	«soporte» en su aplicación (docs/diseno/identidad-clientes.md §2).
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { nombreRol } from '$lib/permisos';
	import { fechaHora } from '$lib/fechas-pantalla';

	type Soporte = {
		estado: 'cerrado' | 'solicitado' | 'abierto' | 'rechazado';
		solicitud: { por: string; motivo: string; cuando: string; tenant?: string } | null;
		hasta: string | null;
		rol: 'lector' | 'operador' | null;
	};

	let {
		soporte,
		operador,
		modo,
		clientId,
		consola,
		porCaducar,
		postura,
		plazos
	}: {
		soporte: Soporte;
		operador: string;
		/* Cómo se entra hoy en esta consola. */
		modo: 'propio' | 'seguridadsi' | 'local';
		/* La aplicación del Entra propio, si está activo. */
		clientId: string | null;
		/* La dirección de esta consola: adonde lleva la invitación. */
		consola: string;
		porCaducar: boolean;
		/* banca: justo a tiempo, 4 horas como mucho y sin renovar (soporte.ts). */
		postura: 'estandar' | 'banca';
		plazos: readonly number[];
	} = $props();

	const textoPlazo = (h: number) =>
		h % 24 === 0 ? `${h / 24} days` : h === 1 ? '1 hour' : `${h} hours`;
	const PLAZOS = $derived(plazos.map((horas) => ({ horas, texto: textoPlazo(horas) })));
	const banca = $derived(postura === 'banca');

	/* Solo un correo con forma de correo entra en el script: viene firmado del panel, pero va a un shell. */
	const CORREO = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
	const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const correo = $derived(
		soporte.solicitud && CORREO.test(soporte.solicitud.por) ? soporte.solicitud.por : null
	);

	/* Para Azure Cloud Shell (bash), en el tenant del cliente. Se puede repetir. */
	const script = $derived(
		correo && clientId && GUID.test(clientId)
			? `APP='${clientId}'
CORREO='${correo}'
CONSOLA='${consola.replace(/'/g, '')}'
SP=$(az ad sp show --id "$APP" --query id -o tsv)
ROLES=$(az ad app show --id "$APP" --query appRoles -o json)
if ! grep -q '"value": "soporte"' <<<"$ROLES"; then
  ROLES=$(python3 -c 'import json,sys,uuid;r=json.loads(sys.argv[1]);r.append({"allowedMemberTypes":["User"],"description":"${operador.replace(/['"\\]/g, '')} support, only while support access is open","displayName":"${operador.replace(/['"\\]/g, '')} support","id":str(uuid.uuid4()),"isEnabled":True,"value":"soporte"});print(json.dumps(r))' "$ROLES")
  az ad app update --id "$APP" --app-roles "$ROLES"
fi
az ad app update --id "$APP" --optional-claims '{"idToken":[{"name":"email","essential":false},{"name":"idp","essential":false},{"name":"acct","essential":false}]}'
INVITADO=$(az ad user list --filter "mail eq '$CORREO'" --query '[0].id' -o tsv)
[ -n "$INVITADO" ] || INVITADO=$(az rest --method POST --uri https://graph.microsoft.com/v1.0/invitations \\
  --body "{\\"invitedUserEmailAddress\\":\\"$CORREO\\",\\"inviteRedirectUrl\\":\\"$CONSOLA\\",\\"sendInvitationMessage\\":true}" \\
  --query invitedUser.id -o tsv)
ROL=$(az ad app show --id "$APP" --query "appRoles[?value=='soporte'].id" -o tsv)
az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP/appRoleAssignedTo" \\
  --body "{\\"principalId\\":\\"$INVITADO\\",\\"resourceId\\":\\"$SP\\",\\"appRoleId\\":\\"$ROL\\"}" -o none 2>/dev/null \\
  || echo "The role was already assigned."
echo "Done: $CORREO is invited and has the support role."`
			: null
	);

	let copiado = $state(false);
	async function copiar() {
		if (!script) return;
		await navigator.clipboard.writeText(script);
		copiado = true;
		setTimeout(() => (copiado = false), 2000);
	}
</script>

<section class="panel bloque" id="soporte">
	<h2>{operador} support access</h2>
	{#if soporte.estado === 'solicitado' && soporte.solicitud}
		<p class="peticion">
			<b>{soporte.solicitud.por}</b> is requesting access:
			<span>"{soporte.solicitud.motivo}"</span>
		</p>

		{#if modo === 'propio'}
			<details open>
				<summary>1. Invite them to your Entra ID</summary>
				{#if script}
					<p class="ayuda">
						Support signs in with their own {operador} account, as a guest in your organization, with
						your MFA and conditional access rules. Paste this in
						<a href="https://shell.azure.com" target="_blank" rel="noopener">shell.azure.com</a>
						(Bash) with an account that can invite users and manage the "Sugardaddy consola" application.
						It invites <b>{correo}</b> and gives them the "soporte" role in the application. Nobody
						else from
						{operador} can sign in with it.
					</p>
					<pre>{script}</pre>
					<button type="button" class="boton" onclick={copiar}>
						{copiado ? 'Copied' : 'Copy the script'}
					</button>
				{:else}
					<p class="mal">
						The request does not have a valid email address, so it cannot be invited. Reject it and
						ask {operador} to request it again.
					</p>
				{/if}
			</details>
			<h3>2. Grant access</h3>
		{:else if modo === 'local'}
			<p class="ayuda">
				This console has no Microsoft sign-in, so support cannot sign in with Microsoft. If you
				grant access, create a local user for them in Users, and remove it when you are done.
			</p>
		{/if}

		<form class="soporte-decision" method="POST" action="?/soporteAceptar" use:enhance>
			<div>
				<label for="rol">Role</label>
				<select id="rol" name="rol">
					<option value="lector" selected>Viewer: read-only</option>
					<option value="operador">Operator: can change honeypots</option>
				</select>
			</div>
			<div>
				<label for="horas">For</label>
				<select id="horas" name="horas">
					{#each PLAZOS as p, i (p.horas)}
						<option value={p.horas} selected={i === 0}>{p.texto}</option>
					{/each}
				</select>
			</div>
			<button class="boton principal">Grant access</button>
		</form>
		<form method="POST" action="?/soporteRechazar" use:enhance>
			<button class="boton">Reject</button>
		</form>
	{:else if soporte.estado === 'abierto'}
		<p class={porCaducar ? 'aviso' : 'ayuda'}>
			Open as <b>{nombreRol(soporte.rol ? [soporte.rol] : [])}</b>
			{#if soporte.hasta}until {fechaHora(soporte.hasta)}.{/if}
			{#if porCaducar}It expires soon{banca ? '' : ': renew it if they still need it'}.{/if}
			Every page they open and every action they take is recorded:
			<a href="/logs?tab=support">Audit logs → Support sessions</a>.
		</p>
		{#if banca}
			<p class="ayuda">
				Just-in-time access cannot be renewed. It closes when it expires or when they sign out; if
				they need more time, {operador} sends a new request.
			</p>
		{:else}
			<form class="soporte-decision" method="POST" action="?/soporteRenovar" use:enhance>
				<div>
					<label for="renovar">Renew for</label>
					<select id="renovar" name="horas">
						{#each PLAZOS as p, i (p.horas)}
							<option value={p.horas} selected={i === 0}>{p.texto} from now</option>
						{/each}
					</select>
				</div>
				<button class="boton">Renew</button>
			</form>
		{/if}
		<form method="POST" action="?/soporteCerrar" use:enhance>
			<button class="boton peligro">Close now</button>
		</form>
		{#if modo === 'propio'}
			<p class="ayuda">
				Closing it cuts their sessions and they cannot sign in again, even as a guest. You can also
				remove the guest from your Entra ID afterwards.
			</p>
		{/if}
	{:else}
		<p class="ayuda">
			Closed. {operador} can only request access; whether to grant it, for how long ({banca
				? '4 hours at most, not renewable'
				: '30 days at most, renewable'}) and with which role is your decision.
		</p>
	{/if}

	<h3>Policy</h3>
	{#if banca}
		<p class="ayuda">
			<b>Just-in-time (banking).</b> You approve each request separately, for 4 hours at most. It cannot
			be renewed and it closes by itself when it expires or when support signs out.
		</p>
	{:else}
		<p class="ayuda">
			<b>Standard.</b> Up to 30 days, renewable. Just-in-time access limits each request to 4 hours, without
			renewal, and closes it when support signs out.
		</p>
	{/if}
	<form method="POST" action="?/posturaSoporte" use:enhance>
		<input type="hidden" name="postura" value={banca ? 'estandar' : 'banca'} />
		<button class="boton">{banca ? 'Use the standard policy' : 'Use just-in-time access'}</button>
	</form>
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

	h3 {
		font-size: 14px;
		font-weight: 600;
		margin: 16px 0 4px;
	}

	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 8px 0 4px;
	}

	.aviso {
		color: var(--warn);
		font-size: 13px;
		margin: 8px 0 4px;
	}

	.mal {
		color: var(--crit);
	}

	.peticion {
		margin: 10px 0 4px;
		font-size: 14px;
	}

	.peticion span {
		color: var(--ink-2);
	}

	details {
		margin-top: 12px;
	}

	summary {
		cursor: pointer;
		font-weight: 600;
		font-size: 14px;
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

	.soporte-decision {
		display: flex;
		gap: 12px;
		align-items: flex-end;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}
</style>
