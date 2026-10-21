<script lang="ts">
	/*
	 * Lo que ve el cliente de una trampa (docs/diseno/modulo-despliegue.md
	 * §8.2): su etiqueta con su color y, si se pide, por qué está así. El
	 * estado lo calcula el servidor (colocacion.ts).
	 */
	type Props = {
		estado: { estado: string; etiqueta: string; motivo: string | null };
		/* Enseñar debajo el motivo; si no, va en el título. */
		motivo?: boolean;
	};
	let { estado, motivo = false }: Props = $props();
</script>

<span class="visible {estado.estado}" title={motivo ? undefined : (estado.motivo ?? undefined)}
	>{estado.etiqueta}</span
>{#if motivo && estado.motivo}<small class="motivo">{estado.motivo}</small>{/if}

<style>
	.visible {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-2);
		white-space: nowrap;
	}

	.comprobada {
		color: var(--ok);
	}

	.por-colocar,
	.degradada {
		color: var(--warn);
	}

	.sin-contacto {
		color: var(--crit);
	}

	.parada,
	.retirando {
		color: var(--ink-3);
	}

	.motivo {
		display: block;
		margin-top: 2px;
		font-size: 12px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}
</style>
