<!-- El tipo de equipo de una tarjeta del mapa. -->
<script lang="ts">
	import type { IconoEquipo } from '$lib/mapa-despliegue';

	let { icono }: { icono: IconoEquipo } = $props();
</script>

<svg
	class="icono"
	width="20"
	height="20"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.7"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if icono === 'servidor'}
		<rect x="3" y="4" width="18" height="6.5" rx="1.5" />
		<rect x="3" y="13.5" width="18" height="6.5" rx="1.5" />
		<path d="M7 7.25h.01M7 16.75h.01M11 7.25h6M11 16.75h6" />
	{:else if icono === 'ficheros'}
		<path d="M3 7a2 2 0 0 1 2-2h4.5l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	{:else if icono === 'maquina'}
		<rect x="3" y="4.5" width="18" height="12" rx="1.5" />
		<path d="M9 20h6M12 16.5V20" />
	{:else if icono === 'nube'}
		<path d="M7 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.6a4.7 4.7 0 0 1-.8 9.4z" />
	{:else}
		<circle cx="12" cy="12" r="9" />
		<path
			d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"
		/>
	{/if}
</svg>

<style>
	.icono {
		flex: none;
		margin-left: auto;
		color: var(--ink-2);
	}
</style>
