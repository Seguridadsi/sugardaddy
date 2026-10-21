<!--
	El icono de una trampa (iconosTrampa): el logotipo del honeypot de código
	abierto en que se basa, si su licencia deja usarlo; si no, el pictograma de
	su tipo de servicio, con el sello de la abeja; y si no tiene tipo, la abeja
	de Sugardaddy. Si uno no llega a cargar, el siguiente. Va junto al nombre de
	la trampa, así que la imagen es decorativa (alt vacío); al pasar por encima
	dice de dónde sale. El tipo lo da el servidor (tipoDeServicio).
-->
<script lang="ts">
	import { asset } from '$app/paths';
	import type { ManifiestoTrampa } from '@sugardaddy/contrato';
	import type { TipoDeServicio } from '@sugardaddy/estilo/pictogramas';
	import { iconosTrampa } from '$lib/logos';

	let {
		procedencia,
		pictograma = null,
		grande = false
	}: {
		procedencia?: ManifiestoTrampa['procedencia'] | null;
		pictograma?: TipoDeServicio | null;
		grande?: boolean;
	} = $props();

	let fallos = $state(0);
	const iconos = $derived(iconosTrampa(procedencia, pictograma));
	const icono = $derived(iconos[Math.min(fallos, iconos.length - 1)]);
	/* El pictograma ya es el recuadro y ocupa la caja entera; lo demás va dentro, con margen. */
	const caja = $derived(grande ? 46 : 30);
	const lado = $derived(icono.de === 'tipo' ? caja : grande ? 34 : 22);
	const fallo = () => {
		if (fallos < iconos.length - 1) fallos++;
	};
</script>

<span class="logo" class:grande class:pictograma={icono.de === 'tipo'} title={icono.titulo}>
	{#if icono.src2x}
		<img
			src={asset(icono.src)}
			srcset="{asset(icono.src)} 64w, {asset(icono.src2x)} 192w"
			sizes="{lado}px"
			alt=""
			width={lado}
			height={lado}
			decoding="async"
			onerror={fallo}
		/>
	{:else}
		<img
			src={asset(icono.src)}
			alt=""
			width={lado}
			height={lado}
			decoding="async"
			onerror={fallo}
		/>
	{/if}
</span>

<style>
	/*
	 * Un recuadro claro en los dos temas: los logotipos y la abeja llevan
	 * contornos negros que sobre el fondo oscuro de la consola se perderían.
	 */
	.logo {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		background: var(--logo-fondo);
		border: 1px solid var(--line);
	}

	.logo.grande {
		width: 46px;
		height: 46px;
		border-radius: 12px;
	}

	/* El pictograma trae su recuadro miel, que se ve igual en los dos temas. */
	.logo.pictograma {
		background: none;
		border: none;
	}

	img {
		display: block;
		object-fit: contain;
	}
</style>
