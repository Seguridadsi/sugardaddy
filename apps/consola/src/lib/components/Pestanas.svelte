<!--
	Las pestañas de una página (lib/pestanas.ts): separan los datos de la
	configuración. Son enlaces, no botones: la pestaña va en la dirección.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { enlacePestana, type Pestana } from '$lib/pestanas';

	let {
		pestanas,
		actual,
		etiqueta = 'Sections'
	}: { pestanas: readonly Pestana[]; actual: string; etiqueta?: string } = $props();
</script>

<nav class="pestanas" aria-label={etiqueta}>
	{#each pestanas as p (p.id)}
		<a
			href={enlacePestana(page.url, pestanas, p.id)}
			aria-current={actual === p.id ? 'page' : undefined}
			data-sveltekit-noscroll>{p.texto}</a
		>
	{/each}
</nav>

<style>
	.pestanas {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-bottom: 14px;
		padding: 8px 0;
		background: var(--bg);
	}

	.pestanas a {
		padding: 7px 14px;
		border-radius: 99px;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
		white-space: nowrap;
	}

	.pestanas a[aria-current='page'] {
		background: var(--accent-soft);
		color: var(--accent);
	}
</style>
