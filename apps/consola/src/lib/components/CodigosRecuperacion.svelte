<!--
	Los códigos de recuperación del segundo factor, recién creados: se enseñan
	una sola vez. Se pueden copiar o bajar como texto (todo en el navegador).
-->
<script lang="ts">
	let { codigos }: { codigos: string[] } = $props();
	let copiado = $state(false);

	const texto = $derived(
		'Sugardaddy recovery codes (each works once)\n\n' + codigos.join('\n') + '\n'
	);
	const enlace = $derived(`data:text/plain;charset=utf-8,${encodeURIComponent(texto)}`);

	async function copiar() {
		try {
			await navigator.clipboard.writeText(texto);
			copiado = true;
		} catch {
			copiado = false;
		}
	}
</script>

<div class="codigos">
	<p>
		Save these recovery codes somewhere safe, away from this computer. Each one signs you in once if
		you lose your phone or passkey. They will not be shown again.
	</p>
	<ol class="mono" aria-label="Recovery codes">
		{#each codigos as c (c)}<li>{c}</li>{/each}
	</ol>
	<div class="acciones">
		<button type="button" class="boton" onclick={copiar}>{copiado ? 'Copied' : 'Copy'}</button>
		<a class="boton" href={enlace} download="sugardaddy-recovery-codes.txt">Download</a>
	</div>
</div>

<style>
	.codigos p {
		font-size: 13px;
		color: var(--ink-2);
		text-align: left;
		margin: 0 0 12px;
	}

	ol {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 18px;
		margin: 0 0 12px;
		padding: 12px 14px 12px 34px;
		background: var(--surface-2);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		font-size: 14px;
		text-align: left;
		user-select: all;
	}

	.acciones {
		display: flex;
		gap: 8px;
	}

	.acciones .boton {
		flex: 1;
		text-align: center;
	}
</style>
