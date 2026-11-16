<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { diaCorto } from '$lib/fechas-pantalla';
	import { haceCuanto } from '$lib/formato';

	let { data, form } = $props();

	/* Con una búsqueda, solo lo encontrado; sin ella, todas. */
	const filas = $derived(form?.busqueda?.filas ?? data.filas);
	const revelada = $derived(form?.revelada ?? null);
	/* Que el formulario no se vacíe al revelar: la búsqueda sigue a la vista. */
	const sinVaciar =
		() =>
		async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) =>
			update({ reset: false });
</script>

<svelte:head>
	<title>Captured passwords — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Captured passwords</h1>
	<p class="cuenta"><b class="mono">{filas.length}</b> unique</p>
</div>

<p class="aviso">
	Passwords are stored encrypted and shown masked. {#if data.revelar}You can reveal one or check
		whether a password was tried; each time is recorded in the audit log.{:else}Revealing them needs
		the Credential viewer role.{/if}
</p>

{#if data.revelar}
	<form class="panel filtros" method="POST" action="?/buscar" use:enhance={sinVaciar}>
		<input
			name="buscar"
			type="password"
			class="mono"
			autocomplete="off"
			placeholder="Was this exact password tried?"
			aria-label="Exact password to check"
		/>
		<button class="boton principal">Check</button>
		{#if form?.busqueda}
			<a class="boton" href={resolve('/passwords')}>Show all</a>
		{/if}
	</form>
{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.busqueda}
	<p class="resultado" role="status">
		{form.busqueda.encontrada
			? 'That exact password was tried on your honeypots.'
			: 'That exact password has not been tried on your honeypots.'}
	</p>
{/if}

{#if !data.palabras.length}
	<p class="aviso">
		There are no alert words yet. Add them in <a href={resolve('/settings')}>Settings</a> (for example,
		your company name) and any password or username that contains them will be flagged.
	</p>
{/if}

<section class="panel">
	{#if filas.length === 0}
		<p class="vacio">No passwords tried{form?.busqueda ? ' matching that check' : ''}.</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Password</th>
					<th class="num">Times</th>
					<th class="num">IP</th>
					<th>Usernames</th>
					<th>Honeypots</th>
					<th>Seen</th>
				</tr>
			</thead>
			<tbody>
				{#each filas as f (f.huella)}
					<tr class:con-alerta={!!f.alerta}>
						<td>
							{#if revelada?.huella === f.huella}
								<code class="mono valor revelada">{revelada.contrasena}</code>
							{:else}
								<code class="mono valor" title="Masked">{f.mascara}</code>
							{/if}
							{#if f.alerta}<span class="alerta" title={f.alerta}>alert</span>{/if}
							{#if data.revelar && revelada?.huella !== f.huella}
								<form method="POST" action="?/revelar" class="revelar" use:enhance={sinVaciar}>
									<input type="hidden" name="huella" value={f.huella} />
									<button class="enlace">Reveal</button>
								</form>
							{/if}
						</td>
						<td class="num mono">{f.veces}</td>
						<td class="num mono">{f.ips}</td>
						<td class="mono usuarios">{(f.usuarios ?? []).join(', ')}</td>
						<td class="trampas">{f.trampas.map((t) => data.nombres[t] ?? t).join(', ')}</td>
						<td class="fecha">
							{haceCuanto(f.ultima, data.ahora)}
							<small>since {diaCorto(f.primera)}</small>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.cabecera {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 16px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
	}

	.cuenta {
		color: var(--ink-2);
		margin: 0;
	}

	.filtros {
		display: flex;
		gap: 10px;
		padding: 12px 14px;
		margin-bottom: 14px;
	}

	.filtros input {
		flex: 1;
	}

	.aviso {
		font-size: 13px;
		color: var(--ink-2);
		margin: 0 0 14px;
	}

	.error {
		color: var(--crit);
		margin: 0 0 14px;
	}

	.resultado {
		margin: 0 0 14px;
		font-weight: 600;
	}

	.revelar {
		display: inline;
		margin-left: 8px;
	}

	.enlace {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		font-size: 12px;
		color: var(--ink-2);
		text-decoration: underline;
		cursor: pointer;
	}

	.revelada {
		background: var(--paper-2, transparent);
	}

	.vacio {
		padding: 18px;
		margin: 0;
		color: var(--ink-3);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	th,
	td {
		text-align: left;
		padding: 9px 14px;
		border-bottom: 1px solid var(--line);
		vertical-align: top;
	}

	th {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.num {
		text-align: right;
	}

	.valor {
		overflow-wrap: anywhere;
	}

	.usuarios,
	.trampas {
		color: var(--ink-2);
		max-width: 220px;
		overflow-wrap: anywhere;
	}

	.fecha small {
		display: block;
		color: var(--ink-3);
		font-size: 11.5px;
	}

	.alerta {
		margin-left: 8px;
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 700;
		color: #fff;
		background: var(--crit);
	}

	tr.con-alerta td:first-child {
		box-shadow: inset 3px 0 0 var(--crit);
	}

	@media (max-width: 1008px) {
		.usuarios,
		.trampas {
			display: none;
		}
	}
</style>
