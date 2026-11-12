<script lang="ts">
	/* Un botón que copia un texto al portapapeles y lo dice. */
	let { texto, etiqueta = 'Copy' }: { texto: string; etiqueta?: string } = $props();
	let estado = $state<'' | 'copiado' | 'fallo'>('');
	async function copiar() {
		try {
			await navigator.clipboard.writeText(texto);
			estado = 'copiado';
		} catch {
			/* Sin permiso del navegador (o sin HTTPS): que lo seleccione a mano. */
			estado = 'fallo';
		}
		setTimeout(() => (estado = ''), 2500);
	}
</script>

<button type="button" class="boton" onclick={copiar} aria-live="polite">
	{estado === 'copiado'
		? 'Copied'
		: estado === 'fallo'
			? 'Could not copy: select the text and copy it'
			: etiqueta}
</button>
