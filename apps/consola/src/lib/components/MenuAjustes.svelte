<!--
	El menú de Ajustes (lib/ajustes-menu.ts): los grupos de /settings y las
	páginas de Ajustes que viven aparte. «All» va al final.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { GRUPOS_AJUSTES, PAGINAS_AJUSTES } from '$lib/ajustes-menu';

	let { actual }: { actual: string } = $props();

	const enlace = (id: string) => `${resolve('/settings')}${id === 'general' ? '' : `?tab=${id}`}`;
	const grupos = GRUPOS_AJUSTES.filter((g) => g.id !== 'all');
</script>

<nav class="grupos" aria-label="Settings sections">
	{#each grupos as g (g.id)}
		<a href={enlace(g.id)} aria-current={actual === g.id ? 'page' : undefined}>{g.texto}</a>
	{/each}
	{#each PAGINAS_AJUSTES as p (p.id)}
		<a href={p.ruta} aria-current={actual === p.id ? 'page' : undefined}>{p.texto}</a>
	{/each}
	<a href={enlace('all')} aria-current={actual === 'all' ? 'page' : undefined}>All</a>
</nav>

<style>
	.grupos {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		max-width: 760px;
		margin-bottom: 14px;
		padding: 8px 0;
		background: var(--bg);
	}

	.grupos a {
		padding: 7px 14px;
		border-radius: 99px;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
		white-space: nowrap;
	}

	.grupos a[aria-current='page'] {
		background: var(--accent-soft);
		color: var(--link);
	}
</style>
