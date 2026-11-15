<!--
	Ajustes → «Move to your own Entra ID»: el asistente para los clientes que aún
	entran como invitados en el Entra de SeguridadSI (b2b.ts). Tres pasos y nadie
	se queda fuera: el Entra propio solo se activa tras una entrada de prueba con
	«admin», el equipo recibe los mismos roles con un script, y solo al final se
	retira el B2B.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { nombreRol } from '$lib/permisos';

	let {
		propio,
		equipo,
		error
	}: {
		propio: { activo: boolean; legible: boolean; clientId: string } | null;
		equipo: { correo: string; nombre: string; rol: string }[];
		error?: string;
	} = $props();

	const CORREO = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
	const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const ROL = /^[a-z-]{3,20}$/;

	/* Para Azure Cloud Shell (bash), en el tenant del cliente: los mismos roles en su aplicación. */
	const script = $derived(
		propio && GUID.test(propio.clientId)
			? [
					`APP='${propio.clientId}'`,
					`SP=$(az ad sp show --id "$APP" --query id -o tsv)`,
					`dar() {`,
					`  U=$(az ad user list --filter "mail eq '$1' or userPrincipalName eq '$1'" --query '[0].id' -o tsv)`,
					`  [ -n "$U" ] || { echo "Not in your directory: $1"; return; }`,
					`  R=$(az ad app show --id "$APP" --query "appRoles[?value=='$2'].id" -o tsv)`,
					`  az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP/appRoleAssignedTo" \\`,
					`    --body "{\\"principalId\\":\\"$U\\",\\"resourceId\\":\\"$SP\\",\\"appRoleId\\":\\"$R\\"}" -o none 2>/dev/null \\`,
					`    && echo "$1: $2" || echo "$1: already has a role"`,
					`}`,
					...equipo
						.filter((p) => CORREO.test(p.correo) && ROL.test(p.rol))
						.map((p) => `dar '${p.correo}' ${p.rol}`)
				].join('\n')
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

<section class="panel bloque" id="migrar">
	<h2>Move to your own Entra ID</h2>
	<p class="aviso">
		Your team signs in as guests in the {page.data.operador} Entra ID. That was the old model: the access
		to your console depends on another organization's directory. Move it to yours in three steps. Nobody
		loses access along the way: local sign-in and the emergency key keep working.
	</p>

	<ol class="pasos">
		<li class:hecho={propio?.activo}>
			<b>Connect your Entra ID</b> in the block above and test it with your "admin" account.
			{#if propio?.activo}<span class="bien">Done.</span>{/if}
		</li>
		<li>
			<b>Give your team their roles in your application.</b>
			{#if equipo.length}
				These people signed in with Microsoft in the last 90 days:
				<ul class="equipo">
					{#each equipo as p (p.correo)}
						<li>{p.nombre} <code>{p.correo}</code> — {nombreRol([p.rol])}</li>
					{/each}
				</ul>
				{#if script}
					Paste this in
					<a href="https://shell.azure.com" target="_blank" rel="noopener">shell.azure.com</a>
					(Bash) to give each of them the same role in your application. Anyone it does not find in your
					directory, invite them first or assign the role by hand.
					<pre>{script}</pre>
					<button type="button" class="boton" onclick={copiar}>
						{copiado ? 'Copied' : 'Copy the script'}
					</button>
				{:else}
					The script appears here once you save your Entra ID.
				{/if}
			{:else}
				Nobody has signed in with Microsoft in the last 90 days. Assign roles in your application in
				Entra ID → Enterprise applications → Sugardaddy consola → Users and groups.
			{/if}
		</li>
		<li>
			<b>Retire the old sign-in.</b> From then on this console only accepts your Entra ID, even if
			the old settings remain on the machine. Other open sessions are closed, and
			{page.data.operador} is told so it can delete your group from its directory.
			{#if error}<p class="mal" role="alert">{error}</p>{/if}
			<form method="POST" action="?/retirarB2B" use:enhance>
				<button class="boton principal" disabled={!propio?.activo || !propio.legible}>
					Retire the old sign-in
				</button>
			</form>
		</li>
	</ol>
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

	.aviso {
		color: var(--warn);
		font-size: 13.5px;
	}

	.bien {
		color: var(--ok);
	}

	.mal {
		color: var(--crit);
	}

	.pasos {
		margin: 10px 0 0;
		padding-left: 20px;
		font-size: 14px;
	}

	.pasos > li {
		margin-bottom: 14px;
	}

	.equipo {
		margin: 6px 0;
		padding-left: 18px;
		font-size: 13px;
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

	form .boton {
		margin-top: 10px;
	}
</style>
