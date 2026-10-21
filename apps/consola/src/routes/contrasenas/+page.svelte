<script lang="ts">
	import { resolve } from '$app/paths';
	import { diaCorto, haceCuanto } from '$lib/formato';

	let { data } = $props();
</script>

<svelte:head>
	<title>Contraseñas — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Contraseñas</h1>
	<p class="cuenta"><b class="mono">{data.filas.length}</b> distintas</p>
</div>

<form class="panel filtros" method="GET">
	<input
		name="buscar"
		class="mono"
		placeholder="Buscar una contraseña"
		value={data.buscar}
		aria-label="Buscar una contraseña"
	/>
	<button class="boton principal">Buscar</button>
</form>

{#if !data.palabras.length}
	<p class="aviso">
		Aún no hay palabras de alerta. Ponlas en <a href={resolve('/ajustes')}>Ajustes</a> (por ejemplo, el
		nombre de la empresa) y se marcará cualquier contraseña o usuario que las contenga.
	</p>
{/if}

<section class="panel">
	{#if data.filas.length === 0}
		<p class="vacio">Ninguna contraseña probada{data.buscar ? ' con esa búsqueda' : ''}.</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Contraseña</th>
					<th class="num">Veces</th>
					<th class="num">IP</th>
					<th>Usuarios</th>
					<th>Trampas</th>
					<th>Vista</th>
				</tr>
			</thead>
			<tbody>
				{#each data.filas as f (f.contrasena)}
					<tr class:con-alerta={!!f.alerta}>
						<td>
							<code class="mono valor">{f.contrasena}</code>
							{#if f.alerta}<span class="alerta" title={f.alerta}>alerta</span>{/if}
						</td>
						<td class="num mono">{f.veces}</td>
						<td class="num mono">{f.ips}</td>
						<td class="mono usuarios">{(f.usuarios ?? []).join(', ')}</td>
						<td class="trampas">{f.trampas.map((t) => data.nombres[t] ?? t).join(', ')}</td>
						<td class="fecha">
							{haceCuanto(f.ultima, data.ahora)}
							<small>desde {diaCorto(f.primera)}</small>
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

	@media (max-width: 760px) {
		.usuarios,
		.trampas {
			display: none;
		}
	}
</style>
