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
		gap: 0;
		margin-bottom: 18px;
		padding: 8px 0 0;
		background: var(--bg);
		border-bottom: 1px solid var(--line);
	}

	/* Pestañas de verdad: subrayado miel en la activa, sin píldoras. */
	.pestanas a {
		padding: 7px 2px;
		margin-right: 18px;
		border-radius: 0;
		border-bottom: 2px solid transparent;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
		white-space: nowrap;
	}

	.pestanas a:hover {
		color: var(--ink);
	}

	.pestanas a[aria-current='page'] {
		color: var(--ink);
		border-bottom-color: var(--accent);
	}
</style>
