<script lang="ts">
	import { resolve } from '$app/paths';
	import FormularioDestino from '$lib/components/FormularioDestino.svelte';

	let { form } = $props();
</script>

<svelte:head>
	<title>Añadir destino — Sugardaddy</title>
</svelte:head>

<a class="volver" href={resolve('/sensores')}>← Sensores</a>

<div class="cabecera">
	<h1>Añadir destino</h1>
	<p class="desc">
		Un sitio sin sensor donde se puede poner algo: un servidor de ficheros, un puesto, una web, una
		cuenta de nube. Con lo que digas aquí, la consola sabe qué trampas valen en él y, si no vale
		ninguna, por qué.
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
		Para poner un sensor en una máquina, hazlo desde <a href={resolve('/sensores')}>Sensores</a>: su
		destino aparece solo. Si ya la has descrito aquí, instálaselo desde su ficha.
	</p>

	<button class="boton principal enviar">Añadir destino</button>
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
