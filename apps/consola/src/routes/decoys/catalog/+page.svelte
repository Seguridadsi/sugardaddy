<script lang="ts">
	import { casa } from '$lib/buscar';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import LogoTrampa from '$lib/components/LogoTrampa.svelte';
	import { nombreTipo } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data } = $props();
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));
	const administra = $derived(puede(page.data.usuario?.roles ?? [], 'ajustes'));

	/* Todas, las disponibles o las instaladas, y lo que se escriba en el buscador. */
	let ver = $state<'todas' | 'disponibles' | 'instaladas'>('todas');
	let buscar = $state('');
	const disponibles = $derived(data.catalogo.filter((m) => m.disponible).length);
	const instaladas = $derived(data.catalogo.filter((m) => m.instaladas > 0).length);
	const visibles = $derived.by(() => {
		/* Primero lo que se puede usar y luego lo que se activa gratis; lo demás, al final. */
		const puesto = (m: (typeof data.catalogo)[number]) =>
			m.disponible ? 0 : m.activarConRegistro ? 1 : 2;
		return data.catalogo
			.filter(
				(m) =>
					(ver !== 'disponibles' || m.disponible) &&
					(ver !== 'instaladas' || m.instaladas > 0) &&
					casa(`${m.nombre} ${m.id} ${nombreTipo[m.tipo]} ${m.resumen}`, buscar)
			)
			.toSorted((a, b) => puesto(a) - puesto(b));
	});
</script>

<svelte:head>
	<title>Catalog — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Catalog</h1>
	<p class="sub">
		The honeypots you can deploy. Pick one to see what it detects and add it{#if data.conPlantillas},
			or <a href={`${resolve('/decoys')}/templates`}>start from a template</a> to deploy a group at once{/if}.
	</p>
</div>

<div class="filtros">
	<div class="pestanas" role="group" aria-label="Which honeypots to show">
		<button type="button" aria-pressed={ver === 'todas'} onclick={() => (ver = 'todas')}>
			All <span class="mono">{data.catalogo.length}</span>
		</button>
		<button
			type="button"
			aria-pressed={ver === 'disponibles'}
			onclick={() => (ver = 'disponibles')}
		>
			Available <span class="mono">{disponibles}</span>
		</button>
		<button type="button" aria-pressed={ver === 'instaladas'} onclick={() => (ver = 'instaladas')}>
			Deployed <span class="mono">{instaladas}</span>
		</button>
	</div>
	<input
		type="search"
		bind:value={buscar}
		placeholder="Search for a honeypot: name, type or what it detects"
		aria-label="Search the catalog"
	/>
</div>

<div class="catalogo">
	{#each visibles as m (m.id)}
		<article class="panel modulo" class:fuera={!m.disponible} class:en-uso={m.instaladas > 0}>
			<header>
				<span class="tag on">{nombreTipo[m.tipo]}</span>
				{#if m.instaladas > 0}
					<span
						class="instalada"
						title={m.instaladas === 1 ? 'One is deployed' : `${m.instaladas} are deployed`}
						>✓ Deployed{m.instaladas > 1 ? ` · ${m.instaladas}` : ''}</span
					>
				{:else if m.disponible}
					<span class="incluida">Available</span>
				{:else}
					<span class="no-incluida">{m.porQueNo}</span>
				{/if}
			</header>
			<div class="titulo">
				<LogoTrampa procedencia={m.procedencia} pictograma={m.pictograma} grande />
				<h3>{m.nombre}</h3>
			</div>
			<p class="desc">{m.resumen}</p>
			<div class="acciones-modulo">
				<a class="boton" href={resolve('/decoys/catalog/[modulo]', { modulo: m.id })}
					>View details</a
				>
				{#if m.disponible && m.desplegable && opera}
					<a class="boton principal" href={resolve('/decoys/new/[modulo]', { modulo: m.id })}
						>Deploy</a
					>
				{/if}
				{#if m.activarConRegistro && administra}
					<a class="boton principal" href="{resolve('/settings')}#free-registration"
						>{m.registroCaducado ? 'Renew' : 'Enable for free'}</a
					>
				{/if}
			</div>
		</article>
	{:else}
		<p class="vacio">
			{buscar.trim()
				? `No honeypot matches "${buscar.trim()}".`
				: 'You have no honeypots available yet.'}
		</p>
	{/each}
</div>

<style>
	.cabecera {
		margin-bottom: 16px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.sub {
		color: var(--ink-2);
		margin: 4px 0 0;
		font-size: 14px;
	}

	.filtros {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 16px;
		margin: 12px 0 16px;
	}

	.pestanas {
		display: flex;
		gap: 4px;
	}

	.pestanas button {
		padding: 7px 14px;
		border: 0;
		border-radius: 99px;
		background: none;
		font: inherit;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink-2);
		cursor: pointer;
	}

	.pestanas button span {
		color: var(--ink-3);
		margin-left: 4px;
	}

	.pestanas button[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.filtros input {
		flex: 1 1 260px;
		max-width: 420px;
	}

	.vacio {
		grid-column: 1 / -1;
		color: var(--ink-3);
	}

	.catalogo {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
	}

	.modulo {
		display: flex;
		flex-direction: column;
		padding: 16px 18px 18px;
	}

	.modulo header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.titulo {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 12px;
	}

	.modulo h3 {
		font-size: 17px;
	}

	.desc {
		font-size: 13.5px;
		color: var(--ink-2);
		margin: 6px 0 12px;
	}

	.modulo .boton {
		margin-top: auto;
		align-self: flex-start;
	}

	.modulo.fuera {
		opacity: 0.75;
	}

	.incluida,
	.no-incluida {
		font-size: 11.5px;
		font-weight: 600;
	}

	.incluida {
		color: var(--ok);
	}

	.instalada {
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--ok);
		color: var(--accent-ink);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.modulo.en-uso {
		border-color: color-mix(in oklab, var(--ok) 55%, var(--line));
		box-shadow: inset 3px 0 0 var(--ok);
	}

	.no-incluida {
		color: var(--ink-3);
	}

	.acciones-modulo {
		display: flex;
		gap: 8px;
		margin-top: auto;
		padding-top: 12px;
	}
</style>
