<script lang="ts">
	/*
	 * Los pasos de una trampa a mano tal como se guardaron (docs/diseno/
	 * modulo-despliegue.md §6.3): cada uno con su texto, su orden y, si la
	 * lleva, la comprobación que tiene que salir bien antes de seguir.
	 */
	type Paso = { n: number; texto: string; orden?: string; comprobar?: string };
	let { pasos, lenguaje }: { pasos: Paso[]; lenguaje: 'powershell' | 'sh' | 'ninguno' } = $props();
	const debeDar = $derived(
		lenguaje === 'powershell' ? 'tiene que dar True' : 'tiene que terminar sin error'
	);
</script>

<ol class="pasos">
	{#each pasos as p (p.n)}
		<li>
			<p>{p.texto}</p>
			{#if p.orden}<pre class="mono codigo">{p.orden}</pre>{/if}
			{#if p.comprobar}
				<p class="comprobar">Comprueba antes de seguir ({debeDar}):</p>
				<pre class="mono codigo">{p.comprobar}</pre>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.pasos {
		margin: 8px 0 0;
		padding-left: 22px;
	}

	.pasos li {
		margin: 0 0 14px;
		font-size: 13.5px;
		color: var(--ink);
	}

	.pasos li:last-child {
		margin-bottom: 0;
	}

	.pasos p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.comprobar {
		margin-top: 8px !important;
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.codigo {
		margin: 6px 0 0;
		padding: 10px 12px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		font-size: 12px;
		line-height: 1.5;
		/* El código no se parte: se desplaza dentro de su caja, nunca la página. */
		overflow-x: auto;
		white-space: pre;
		max-width: 100%;
	}
</style>
