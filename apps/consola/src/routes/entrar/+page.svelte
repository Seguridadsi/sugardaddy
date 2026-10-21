<script lang="ts">
	import { asset } from '$app/paths';

	let { data } = $props();
</script>

<svelte:head>
	<title>Entrar — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	<!-- La consola va en oscuro: «Daddy» en claro. Con el tema claro, el logotipo original. -->
	<h1>
		<img
			class="logo oscuro"
			src={asset('/logo-fondo-oscuro-512.webp')}
			alt="Sugardaddy"
			width="200"
			height="193"
		/>
		<img
			class="logo claro"
			loading="lazy"
			src={asset('/logo-512.webp')}
			alt="Sugardaddy"
			width="200"
			height="193"
		/>
	</h1>
	<p class="sub">Consola del nodo</p>

	{#if data.error}
		<p class="error" role="alert">{data.error}</p>
	{:else if data.salida}
		<p class="ok" role="status">Has salido.</p>
	{/if}

	{#if data.configurado}
		<a class="boton principal" href="/auth/login?volverA={encodeURIComponent(data.volverA)}">
			Entrar con Microsoft
		</a>
	{:else}
		<p class="error">Esta consola no tiene configurado Entra ID.</p>
	{/if}
	<a class="emergencia" href="/emergencia">Entrada de emergencia con llave</a>
</div>

<style>
	.caja {
		width: min(380px, calc(100% - 32px));
		margin: 12vh auto 0;
		padding: 34px 30px 30px;
		text-align: center;
	}

	h1 {
		line-height: 0;
	}

	.logo {
		width: min(200px, 60vw);
		height: auto;
	}

	.claro,
	:global(:root[data-theme='light']) .oscuro {
		display: none;
	}

	:global(:root[data-theme='light']) .claro {
		display: inline;
	}

	.sub {
		margin: 10px 0 22px;
		color: var(--ink-3);
		font-size: 13.5px;
	}

	.error,
	.ok {
		font-size: 13.5px;
		margin: 0 0 18px;
		padding: 10px 12px;
		border-radius: var(--r-sm);
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}

	.ok {
		background: var(--accent-soft);
	}

	.emergencia {
		display: block;
		margin-top: 16px;
		font-size: 12.5px;
		color: var(--ink-3);
	}

	.boton {
		display: block;
		padding: 10px;
	}
</style>
