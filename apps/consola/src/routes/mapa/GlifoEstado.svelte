<!--
	El estado de una trampa en el mapa: además del color, cada estado tiene su
	forma, para que se distingan sin depender solo de él.
-->
<script lang="ts">
	let { estado, titulo }: { estado: string; titulo?: string } = $props();
</script>

<svg
	class="glifo {estado}"
	width="12"
	height="12"
	viewBox="0 0 12 12"
	role="img"
	aria-label={titulo}
>
	{#if titulo}<title>{titulo}</title>{/if}
	{#if estado === 'comprobada'}
		<circle cx="6" cy="6" r="5" />
	{:else if estado === 'colocada'}
		<circle class="hueco" cx="6" cy="6" r="4" />
	{:else if estado === 'degradada' || estado === 'por-colocar'}
		<path d="M6 1l5.5 10h-11z" />
	{:else if estado === 'sin-contacto'}
		<rect x="1" y="1" width="10" height="10" rx="1.5" />
		<path class="aspa" d="M3.8 3.8l4.4 4.4M8.2 3.8l-4.4 4.4" />
	{:else}
		<rect class="hueco" x="2" y="2" width="8" height="8" rx="1" />
	{/if}
</svg>

<style>
	.glifo {
		flex: none;
		fill: var(--ink-3);
		stroke: none;
	}

	.comprobada {
		fill: var(--ok);
	}

	.colocada {
		color: var(--s-media);
	}

	.degradada,
	.por-colocar {
		fill: var(--warn);
	}

	.sin-contacto {
		fill: var(--crit);
	}

	.hueco {
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
	}

	.parada,
	.retirando {
		color: var(--ink-3);
	}

	.aspa {
		fill: none;
		stroke: var(--bg);
		stroke-width: 1.6;
	}
</style>
