<script lang="ts">
	import { navigating } from '$app/state';
	import ListaEventos from '$lib/components/ListaEventos.svelte';

	let { data } = $props();

	/*
	 * Intro en el buscador lanza la búsqueda sin depender del envío implícito del
	 * navegador (un desplegable de autocompletar o de un gestor de contraseñas
	 * abierto sobre el campo se queda con la tecla). Y mientras llega la respuesta
	 * se dice: la dirección no cambia hasta que la consulta termina, y con muchos
	 * eventos parecía que no había pasado nada.
	 */
	function buscarConIntro(ev: KeyboardEvent & { currentTarget: HTMLInputElement }) {
		if (ev.key !== 'Enter' || ev.isComposing) return;
		ev.preventDefault();
		ev.currentTarget.form?.requestSubmit();
	}
	const buscando = $derived(navigating.to?.url.pathname === '/events');

	const ETIQUETA_TRIAJE: Record<string, string> = {
		revisado: 'Reviewed',
		'falso-positivo': 'False positive',
		interesante: 'Interesting'
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
		if (data.filtro.escaner) p.set('escaner', data.filtro.escaner);
		const q = p.toString();
		return '/events/csv' + (q ? `?${q}` : '');
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
		if (data.filtro.escaner) p.set('escaner', data.filtro.escaner);
		if (data.filtro.agrupar) p.set('agrupar', '1');
		const q = p.toString();
		return '/events' + (q ? `?${q}` : '');
	});
</script>

<svelte:head>
	<title>Events — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<h1>Events</h1>
	</div>
	<div class="acciones">
		{#if data.agrupado}
			<p
				class="cuenta"
				title="Grouped over the most recent events loaded, not over the whole database"
			>
				<b class="mono">{data.eventos.length}</b> groups · {data.cargados} loaded
			</p>
		{:else}
			<p class="cuenta"><b class="mono">{data.eventos.length}</b> of {data.total}</p>
		{/if}
		{#if data.puedeReglas}
			<a class="csv" href="/events/rules">Triage rules</a>
		{/if}
		<a class="csv" href={csvHref} data-sveltekit-reload>Export CSV</a>
	</div>
</div>

<form class="panel filtros" method="GET">
	{#if data.filtro.usuario}
		<input type="hidden" name="usuario" value={data.filtro.usuario} />
	{/if}
	<div class="buscar">
		<label for="q">Search events</label>
		<input
			id="q"
			name="q"
			type="search"
			enterkeyhint="search"
			value={data.filtro.q}
			onkeydown={buscarConIntro}
			placeholder="source IP or CIDR, command, username, URL, password, text…"
		/>
	</div>
	<div>
		<label for="desde">Minimum severity</label>
		<select id="desde" name="desde" value={data.filtro.desde}>
			<option value="baja">All</option>
			<option value="media">Medium or higher</option>
			<option value="alta">High or higher</option>
			<option value="critica">Critical only</option>
		</select>
	</div>
	<div>
		<label for="trampa">Honeypot</label>
		<select id="trampa" name="trampa" value={data.filtro.trampa}>
			<option value="">All</option>
			{#each data.trampas as s (s.id)}
				<option value={s.id}>{s.nombre}</option>
			{/each}
		</select>
	</div>
	<div>
		<label for="origen">Source IP</label>
		<input id="origen" name="origen" value={data.filtro.origen} placeholder="10.30." class="mono" />
	</div>
	<div>
		<label for="triaje">Triage</label>
		<select id="triaje" name="triaje" value={data.filtro.triaje}>
			<option value="">All</option>
			<option value="sin">Untriaged</option>
			{#each data.estadosTriaje as est (est)}
				<option value={est}>{ETIQUETA_TRIAJE[est] ?? est}</option>
			{/each}
		</select>
	</div>
	<label class="agrupar">
		<input type="checkbox" name="agrupar" value="1" checked={data.filtro.agrupar} />
		Group repeated events
	</label>
	<button class="boton principal" aria-busy={buscando}>{buscando ? 'Searching…' : 'Filter'}</button>
</form>

{#if data.filtro.usuario}
	<p class="chip-filtro">
		User <b class="mono">{data.filtro.usuario}</b>
		<a href={sinUsuarioHref} data-sveltekit-reload>remove</a>
	</p>
{/if}

<section class="panel" class:buscando aria-busy={buscando}>
	{#if data.eventos.length === 0}
		<p class="vacio">No events match these filters.</p>
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

	@media (max-width: 1008px) {
		.filtros {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* La lista de antes, apagada mientras llega la de la búsqueda nueva. */
	.buscando {
		opacity: 0.5;
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
