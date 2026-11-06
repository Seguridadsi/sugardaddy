<script lang="ts">
	import { resolve } from '$app/paths';
	import FormularioDestino from '$lib/components/FormularioDestino.svelte';

	let { form } = $props();
</script>

<svelte:head>
	<title>Add target — Sugardaddy</title>
</svelte:head>

<a class="volver" href={resolve('/sensors')}>← Sensors</a>

<div class="cabecera">
	<h1>Add target</h1>
	<p class="desc">
		A place without a sensor where something can be deployed: a file server, a workstation, a
		website, a cloud account. With what you enter here, the console knows which decoys fit it and,
		if none does, why.
	</p>
</div>

<form class="panel formulario" method="POST">
	{#if form?.errores}
		<ul class="errores" role="alert">
			{#each form.errores as e (e)}<li>{e}</li>{/each}
		</ul>
	{/if}

	<FormularioDestino tipo={form?.tipo ?? 'maquina'} elegirTipo valores={form?.valores} />

	<p class="nota">
		To put a sensor on a machine, do it from <a href={resolve('/sensors')}>Sensors</a>: its target
		appears on its own. If you have already described it here, install the sensor from its page.
	</p>

	<button class="boton principal enviar">Add target</button>
</form>

<style>
	.volver {
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.cabecera {
		margin: 14px 0 20px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.desc {
		max-width: 70ch;
		color: var(--ink-2);
		margin: 6px 0 0;
	}

	.formulario {
		max-width: 720px;
		padding: 18px 20px 22px;
	}

	.errores {
		margin: 0 0 14px;
		padding: 10px 14px 10px 30px;
		border-radius: var(--r-sm);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
		color: var(--crit);
		font-size: 13px;
	}

	.nota {
		margin: 18px 0 0;
		font-size: 13px;
		color: var(--ink-3);
	}

	.enviar {
		margin-top: 18px;
	}
</style>
