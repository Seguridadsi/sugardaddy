<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { nombreZona, zonasConocidas } from '$lib/fechas';

	let { guardada, navegador }: { guardada: string | null; navegador: string } = $props();

	/*
	 * La lista entera, solo en el navegador: son más de 400 y no hace falta
	 * repetirlas en el HTML de cada página. Hasta entonces está la que hay elegida.
	 */
	let zonas = $state<string[]>([]);
	onMount(() => (zonas = zonasConocidas()));
	const opciones = $derived([...new Set([...(guardada ? [guardada] : []), ...zonas])]);
</script>

<form
	class="menu-zona"
	method="POST"
	action="/account?/zonaHoraria"
	use:enhance={() =>
		({ update }) =>
			update({ reset: false })}
>
	<label for="zona-horaria">Time zone</label>
	<select
		id="zona-horaria"
		name="zona"
		value={guardada ?? ''}
		onchange={(e) => e.currentTarget.form?.requestSubmit()}
	>
		<option value="">Browser ({nombreZona(navegador)})</option>
		{#each opciones as z (z)}
			<option value={z}>{nombreZona(z)}</option>
		{/each}
	</select>
</form>

<style>
	.menu-zona {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: 4px;
	}

	label {
		font-size: 11.5px;
		color: var(--ink-3);
	}

	select {
		width: 100%;
		padding: 5px 6px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		font: inherit;
		font-size: 12.5px;
		color: var(--ink-2);
		background: var(--surface);
	}
</style>
