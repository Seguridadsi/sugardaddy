<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { pestanaDe } from '$lib/pestanas';
	import { fechaCorta, fechaHora } from '$lib/fechas-pantalla';
	import { nombreRol } from '$lib/permisos';
	import MenuAjustes from '$lib/components/MenuAjustes.svelte';
	import Pestanas from '$lib/components/Pestanas.svelte';

	let { data, form } = $props();

	/* La lista y su confirmación (datos), las revisiones hechas y el plazo (configuración). */
	const PESTANAS = [
		{ id: 'accounts', texto: 'Accounts' },
		{ id: 'reviews', texto: 'Reviews' },
		{ id: 'inactivity', texto: 'Inactivity' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));

	const ORIGEN = { local: 'Local user', entra: 'Microsoft', oidc: 'Identity provider' } as const;
	const activas = $derived(data.cuentas.filter((c) => !c.desactivada).length);
	const yo = $derived(page.data.usuario?.oid ?? null);
</script>

<svelte:head>
	<title>Access review — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Settings</h1>
</div>

<MenuAjustes actual="access-review" />

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Access review sections" />

{#if form?.mensaje}<p class="mensaje" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

{#if pestana === 'accounts'}
	<section class="panel bloque">
		<h2>Quarterly review</h2>
		{#if data.estado.vencida}
			<p class="mal">
				The review is overdue{#if data.estado.proxima}
					since {fechaCorta(data.estado.proxima)}{/if}. Check the list below and confirm it.
			</p>
		{:else if data.estado.proxima}
			<p class="ayuda">Next review due on {fechaCorta(data.estado.proxima)}.</p>
		{/if}
		{#if data.estado.ultima}
			<p class="ayuda">
				Last confirmed by {data.estado.ultima.quien} on {fechaHora(data.estado.ultima.cuando)}.
			</p>
		{/if}
		<p class="ayuda">
			Check that every account below still needs access with that role, disable the ones that do
			not, and confirm. The review records who confirmed it, when, and the list as it was.
		</p>
		<form method="POST" action="?/confirmar" use:enhance class="confirmar">
			<label for="nota">Note (optional)</label>
			<input id="nota" name="nota" maxlength="500" placeholder="e.g. ticket or meeting reference" />
			<button class="boton principal">Confirm the list ({activas} active)</button>
		</form>
	</section>

	<section class="panel">
		<ul class="cuentas">
			{#each data.cuentas as c (c.oid)}
				<li class:apagada={!!c.desactivada}>
					<div>
						<b>{c.nombre}</b>
						<small>{c.correo} · {ORIGEN[c.origen]} · {nombreRol(c.roles) || 'no role'}</small>
					</div>
					<div class="entrada">
						{#if c.ultimaEntrada}
							Last sign-in {fechaHora(c.ultimaEntrada)}
						{:else}
							Never signed in
						{/if}
						{#if c.desactivada}
							<small class="mal">
								Disabled on {fechaCorta(c.desactivada)}{c.motivo === 'inactividad'
									? ' for inactivity'
									: c.desactivadaPor
										? ` by ${c.desactivadaPor}`
										: ''}
							</small>
						{:else if c.caduca}
							<small>Disabled automatically on {fechaCorta(c.caduca)} without a sign-in</small>
						{/if}
					</div>
					<form method="POST" action={c.desactivada ? '?/reactivar' : '?/desactivar'} use:enhance>
						<input type="hidden" name="oid" value={c.oid} />
						{#if c.desactivada}
							<button class="boton">Enable</button>
						{:else if c.oid !== yo}
							<button class="boton peligro">Disable</button>
						{/if}
					</form>
				</li>
			{:else}
				<li class="vacio">Nobody has signed in yet.</li>
			{/each}
		</ul>
	</section>
	<p class="nota">
		Disabling an account closes its sessions and stops it from signing in, from any sign-in method.
		It is not deleted: you can enable it again here. The last active administrator cannot be
		disabled. Accounts from Microsoft or your identity provider are listed once they have signed in;
		remove them there when they leave the company.
	</p>
{:else if pestana === 'reviews'}
	<section class="panel">
		<ul class="cuentas">
			{#each data.revisiones as r (r.id)}
				<li>
					<div>
						<b>{fechaHora(r.cuando)}</b>
						<small>{r.quien}{r.nota ? ` · ${r.nota}` : ''}</small>
					</div>
					<div class="entrada">{r.activas} active of {r.cuentas} accounts</div>
				</li>
			{:else}
				<li class="vacio">No review has been confirmed yet.</li>
			{/each}
		</ul>
	</section>
{:else}
	<section class="panel bloque">
		<h2>Disable inactive accounts</h2>
		<p class="ayuda">
			An account that does not sign in for this many days is disabled automatically (not deleted),
			its sessions are closed and the change is recorded in the audit log. The last active
			administrator is never disabled.
		</p>
		<form method="POST" action="?/dias" use:enhance class="dias">
			<input
				id="dias"
				name="dias"
				type="number"
				inputmode="numeric"
				min={data.minimo}
				max={data.maximo}
				value={data.dias}
			/>
			<label for="dias">days without signing in ({data.minimo} to {data.maximo})</label>
			<button class="boton">Save</button>
		</form>
	</section>
{/if}

<style>
	.cabecera {
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
	}

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

	.mal {
		color: var(--crit);
	}

	.confirmar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		align-items: center;
		margin-top: 12px;
	}

	.confirmar input {
		flex: 1 1 240px;
	}

	.confirmar label {
		flex-basis: 100%;
		font-size: 13px;
	}

	.dias {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 12px;
	}

	.dias input {
		width: 90px;
	}

	.cuentas {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.cuentas li {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 2fr) auto;
		gap: 14px;
		align-items: center;
		padding: 10px 17px;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	.cuentas li:last-child {
		border-bottom: none;
	}

	.cuentas small {
		display: block;
		color: var(--ink-3);
		font-size: 12px;
	}

	.cuentas .apagada b {
		color: var(--ink-3);
	}

	.entrada {
		color: var(--ink-2);
	}

	.vacio {
		display: block !important;
		color: var(--ink-2);
		text-align: center;
		padding: 24px;
	}

	.nota {
		font-size: 12.5px;
		color: var(--ink-3);
		margin: 12px 2px 0;
		max-width: 760px;
	}

	.mensaje {
		color: var(--ok);
	}

	.error {
		color: var(--crit);
	}

	@media (max-width: 760px) {
		.cuentas li {
			grid-template-columns: minmax(0, 1fr);
			gap: 4px;
		}
	}
</style>
