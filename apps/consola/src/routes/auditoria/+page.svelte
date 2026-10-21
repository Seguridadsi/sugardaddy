<script lang="ts">
	import { diaCorto, horaCorta } from '$lib/formato';

	let { data } = $props();
	const detalle = (d: Record<string, unknown>) =>
		Object.entries(d)
			.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
			.join(' · ');
</script>

<svelte:head>
	<title>Auditoría — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<h1>Auditoría</h1>
	</div>
	<form method="GET">
		<input name="q" value={data.q} placeholder="Buscar: correo, acción, IP…" />
	</form>
</div>

<section class="panel">
	<ul>
		{#each data.filas as a (a.id)}
			<li>
				<span class="cuando mono">{diaCorto(a.cuando)} {horaCorta(a.cuando)}</span>
				<span class="quien">{a.quien}</span>
				<span class="accion">{a.accion}</span>
				<span class="detalle mono" title={detalle(a.detalle)}>{detalle(a.detalle)}</span>
			</li>
		{:else}
			<li class="vacio">Nada que coincida.</li>
		{/each}
	</ul>
</section>
<p class="nota">
	La auditoría solo crece: nadie, tampoco SeguridadSI, puede borrar líneas desde la consola.
</p>

<style>
	.cabecera {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.cabecera form {
		min-width: 280px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: grid;
		grid-template-columns: 120px minmax(120px, 1fr) minmax(140px, 1fr) minmax(0, 2fr);
		gap: 14px;
		padding: 10px 17px;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
		align-items: baseline;
	}

	li:last-child {
		border-bottom: none;
	}

	.cuando {
		font-size: 12px;
		color: var(--ink-3);
	}

	.quien {
		color: var(--ink-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.accion {
		font-weight: 600;
	}

	.detalle {
		font-size: 11.5px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.vacio {
		display: block;
		color: var(--ink-2);
		text-align: center;
		padding: 24px;
	}

	.nota {
		font-size: 12.5px;
		color: var(--ink-3);
		margin: 12px 2px 0;
	}

	@media (max-width: 760px) {
		li {
			grid-template-columns: minmax(0, 1fr);
			gap: 2px;
		}
	}
</style>
