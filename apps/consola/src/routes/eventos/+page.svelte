<script lang="ts">
	import ListaEventos from '$lib/components/ListaEventos.svelte';

	let { data } = $props();

	const ETIQUETA_TRIAJE: Record<string, string> = {
		revisado: 'Revisado',
		'falso-positivo': 'Falso positivo',
		interesante: 'Interesante'
	};

	/* Descarga de los eventos filtrados, con el mismo filtro que se está viendo. */
	const csvHref = $derived.by(() => {
		const p = new URLSearchParams();
		if (data.filtro.desde && data.filtro.desde !== 'baja') p.set('desde', data.filtro.desde);
		if (data.filtro.trampa) p.set('trampa', data.filtro.trampa);
		if (data.filtro.origen) p.set('origen', data.filtro.origen);
		if (data.filtro.usuario) p.set('usuario', data.filtro.usuario);
		if (data.filtro.q) p.set('q', data.filtro.q);
		if (data.filtro.triaje) p.set('triaje', data.filtro.triaje);
		const q = p.toString();
		return '/eventos/csv' + (q ? `?${q}` : '');
	});
	/* El CSV siempre sale sin agrupar (datos completos), aunque la vista esté agrupada. */

	/* Quitar el filtro por usuario (que llega desde un perfil), conservando el resto. */
	const sinUsuarioHref = $derived.by(() => {
		const p = new URLSearchParams();
		if (data.filtro.desde && data.filtro.desde !== 'baja') p.set('desde', data.filtro.desde);
		if (data.filtro.trampa) p.set('trampa', data.filtro.trampa);
		if (data.filtro.origen) p.set('origen', data.filtro.origen);
		if (data.filtro.q) p.set('q', data.filtro.q);
		if (data.filtro.triaje) p.set('triaje', data.filtro.triaje);
		if (data.filtro.agrupar) p.set('agrupar', '1');
		const q = p.toString();
		return '/eventos' + (q ? `?${q}` : '');
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
		{#if data.agrupado}
			<p class="cuenta" title="Agrupado sobre los últimos eventos cargados, no sobre toda la base">
				<b class="mono">{data.eventos.length}</b> grupos · {data.cargados} cargados
			</p>
		{:else}
			<p class="cuenta"><b class="mono">{data.eventos.length}</b> de {data.total}</p>
		{/if}
		{#if data.puedeReglas}
			<a class="csv" href="/eventos/reglas">Reglas de triaje</a>
		{/if}
		<a class="csv" href={csvHref} data-sveltekit-reload>Exportar CSV</a>
	</div>
</div>

<form class="panel filtros" method="GET">
	{#if data.filtro.usuario}
		<input type="hidden" name="usuario" value={data.filtro.usuario} />
	{/if}
	<div class="buscar">
		<label for="q">Buscar en el evento</label>
		<input
			id="q"
			name="q"
			value={data.filtro.q}
			placeholder="comando, usuario, URL, contraseña, texto…"
		/>
	</div>
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
	<div>
		<label for="triaje">Triaje</label>
		<select id="triaje" name="triaje" value={data.filtro.triaje}>
			<option value="">Todos</option>
			<option value="sin">Sin triar</option>
			{#each data.estadosTriaje as est (est)}
				<option value={est}>{ETIQUETA_TRIAJE[est] ?? est}</option>
			{/each}
		</select>
	</div>
	<label class="agrupar">
		<input type="checkbox" name="agrupar" value="1" checked={data.filtro.agrupar} />
		Agrupar repetidos
	</label>
	<button class="boton principal">Filtrar</button>
</form>

{#if data.filtro.usuario}
	<p class="chip-filtro">
		Usuario <b class="mono">{data.filtro.usuario}</b>
		<a href={sinUsuarioHref} data-sveltekit-reload>quitar</a>
	</p>
{/if}

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
			conTriaje={data.puedeTriar}
			estadosTriaje={data.estadosTriaje}
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
		grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
		gap: 14px;
		align-items: end;
		padding: 4px 17px 16px;
		margin-bottom: 16px;
	}

	/* La búsqueda ocupa su propia fila entera, encima de los filtros. */
	.buscar {
		grid-column: 1 / -1;
	}

	/* Agrupar repetidos: su propia fila, bajo los filtros. */
	.agrupar {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		color: var(--ink-2);
		cursor: pointer;
		width: max-content;
	}

	.agrupar input {
		margin: 0;
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

	/* Chip del filtro por usuario (llega desde un perfil; no está en el formulario). */
	.chip-filtro {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: -4px 0 16px;
		font-size: 13px;
		color: var(--ink-2);
	}

	.chip-filtro b {
		color: var(--ink);
	}

	.chip-filtro a {
		color: var(--ink-3);
		text-decoration: underline;
	}

	.chip-filtro a:hover {
		color: var(--ink);
	}
</style>
