<!--
	Plegar y desplegar una sección (el Resumen: eventos, mapas, trampas por sensor).
	Quien lo usa enlaza `plegado` y pinta su contenido solo si no lo está. Se
	recuerda en este navegador, por sección; sin almacenamiento, todo desplegado.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	let {
		id,
		titulo,
		plegado = $bindable(false)
	}: { id: string; titulo: string; plegado?: boolean } = $props();

	const clave = $derived(`sd.plegado.${id}`);

	onMount(() => {
		try {
			plegado = localStorage.getItem(clave) === '1';
		} catch {
			/* Sin almacenamiento (privado, bloqueado): se queda desplegado. */
		}
	});

	function alternar() {
		plegado = !plegado;
		try {
			if (plegado) localStorage.setItem(clave, '1');
			else localStorage.removeItem(clave);
		} catch {
			/* Igual que arriba: se pliega, pero no se recuerda. */
		}
	}
</script>

<button
	type="button"
	class="plegar"
	aria-expanded={!plegado}
	aria-label="{plegado ? 'Show' : 'Hide'} {titulo}"
	title={plegado ? 'Show' : 'Hide'}
	onclick={alternar}
>
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class:plegado>
		<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" />
	</svg>
	<span>{plegado ? 'Show' : 'Hide'}</span>
</button>

<style>
	.plegar {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--ink-3);
		font-size: 12px;
		cursor: pointer;
	}

	.plegar:hover {
		color: var(--ink);
		border-color: var(--line-strong);
	}

	svg {
		transition: transform 0.15s ease;
	}

	svg.plegado {
		transform: rotate(-90deg);
	}
</style>
