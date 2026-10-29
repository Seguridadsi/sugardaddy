<script lang="ts">
	import ListaEventos from '$lib/components/ListaEventos.svelte';

	let { data } = $props();

	/* Descarga de los eventos filtrados, con el mismo filtro que se está viendo. */
	const csvHref = $derived.by(() => {
		const p = new URLSearchParams();
		if (data.filtro.desde && data.filtro.desde !== 'baja') p.set('desde', data.filtro.desde);
		if (data.filtro.trampa) p.set('trampa', data.filtro.trampa);
		if (data.filtro.origen) p.set('origen', data.filtro.origen);
		const q = p.toString();
		return '/eventos/csv' + (q ? `?${q}` : '');
	});
</script>

<svelte:head>
	<title>Eventos — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<h1>Eventos</h1>
	</div>
	<div class="acciones">
		<p class="cuenta"><b class="mono">{data.eventos.length}</b> de {data.total}</p>
		<a class="csv" href={csvHref} data-sveltekit-reload>Exportar CSV</a>
	</div>
</div>

<form class="panel filtros" method="GET">
	<div>
		<label for="desde">Severidad mínima</label>
		<select id="desde" name="desde" value={data.filtro.desde}>
			<option value="baja">Todas</option>
			<option value="media">Media o más</option>
			<option value="alta">Alta o más</option>
			<option value="critica">Solo críticas</option>
		</select>
	</div>
	<div>
		<label for="trampa">Trampa</label>
		<select id="trampa" name="trampa" value={data.filtro.trampa}>
			<option value="">Todas</option>
			{#each data.trampas as s (s.id)}
				<option value={s.id}>{s.nombre}</option>
			{/each}
		</select>
	</div>
	<div>
		<label for="origen">IP de origen</label>
		<input id="origen" name="origen" value={data.filtro.origen} placeholder="10.30." class="mono" />
	</div>
	<button class="boton principal">Filtrar</button>
</form>

<section class="panel">
	{#if data.eventos.length === 0}
		<p class="vacio">Ningún evento con estos filtros.</p>
	{:else}
		<ListaEventos
			eventos={data.eventos}
			nombres={data.nombres}
			modulos={data.modulos}
			geos={data.geos}
			ahora={data.ahora}
		/>
	{/if}
</section>

<style>
	.cabecera {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 18px;
	}

	.acciones {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.csv {
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: 6px 13px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
		white-space: nowrap;
	}

	.csv:hover {
		background: var(--surface-2);
		color: var(--ink);
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.cuenta {
		margin: 0;
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.cuenta b {
		font-size: 17px;
		color: var(--ink);
	}

	.filtros {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
		gap: 14px;
		align-items: end;
		padding: 4px 17px 16px;
		margin-bottom: 16px;
	}

	@media (max-width: 760px) {
		.filtros {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.vacio {
		padding: 30px 17px;
		margin: 0;
		color: var(--ink-2);
		text-align: center;
	}
</style>
