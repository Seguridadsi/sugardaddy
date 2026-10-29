<script lang="ts">
	/*
	 * Página de upsell de la edición community: la función real (Respuesta,
	 * Avisos/SIEM) es de pago. Aquí se cuenta qué hace y cómo conseguirla.
	 */
	interface Props {
		titulo: string;
		intro: string;
		puntos: string[];
		gratis?: string;
	}
	let { titulo, intro, puntos, gratis }: Props = $props();

	const CONTACTO = 'https://www.seguridadsi.com';
	const CORREO = 'contacto@seguridadsi.com';
</script>

<svelte:head>
	<title>{titulo} — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>{titulo} <span class="sello">de pago</span></h1>
	<p class="intro">{intro}</p>
</div>

<section class="panel">
	<h2>Qué suma la edición de pago</h2>
	<ul>
		{#each puntos as punto}
			<li>{punto}</li>
		{/each}
	</ul>
	{#if gratis}
		<p class="gratis">{gratis}</p>
	{/if}
</section>

<div class="cta">
	<p>¿Lo quieres en tu nodo? Hablamos y te lo activamos.</p>
	<div class="acciones">
		<a class="boton" href={CONTACTO} target="_blank" rel="noopener noreferrer">
			Ver la edición de pago
		</a>
		<a class="correo" href="mailto:{CORREO}">{CORREO}</a>
	</div>
</div>

<style>
	.cabecera {
		margin-bottom: 20px;
	}

	h1 {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 0 0 10px;
	}

	.sello {
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 3px 9px;
		border-radius: 99px;
		background: color-mix(in oklab, var(--accent) 16%, var(--surface));
		color: var(--accent);
		border: 1px solid color-mix(in oklab, var(--accent) 35%, var(--line));
	}

	.intro {
		max-width: 62ch;
		margin: 0;
		color: var(--ink-2);
		line-height: 1.5;
	}

	.panel {
		padding: 20px 22px;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
	}

	.panel h2 {
		margin: 0 0 14px;
		font-size: 15px;
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 11px;
	}

	li {
		position: relative;
		padding-left: 24px;
		line-height: 1.45;
	}

	li::before {
		content: '';
		position: absolute;
		left: 4px;
		top: 7px;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		background: var(--accent);
	}

	.gratis {
		margin: 16px 0 0;
		padding-top: 14px;
		border-top: 1px solid var(--line);
		color: var(--ink-2);
		font-size: 14px;
		line-height: 1.5;
	}

	.cta {
		margin-top: 22px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
	}

	.cta p {
		margin: 0;
		font-weight: 600;
	}

	.acciones {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
	}

	.boton {
		display: inline-block;
		padding: 9px 18px;
		border-radius: var(--r-sm);
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 700;
		text-decoration: none;
	}

	.boton:hover {
		filter: brightness(1.05);
	}

	.correo {
		color: var(--ink-2);
		font-size: 14px;
	}
</style>
