<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import LogoTrampa from '$lib/components/LogoTrampa.svelte';
	import { nombreTipo } from '$lib/formato';
	import { iconoTrampa } from '$lib/logos';
	import { puede } from '$lib/permisos';

	let { data } = $props();
	const m = $derived(data.modulo);
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));
	/* Si lleva el logotipo de un proyecto, el reconocimiento que pide su licencia. */
	const credito = $derived(iconoTrampa(m.procedencia).credito);
</script>

<svelte:head>
	<title>{m.nombre} — Sugardaddy</title>
</svelte:head>

<a class="volver" href={resolve('/trampas')}>← Trampas</a>

<div class="cabecera">
	<div class="titulo">
		<LogoTrampa procedencia={m.procedencia} pictograma={m.pictograma} grande />
		<div>
			<p class="eyebrow">{nombreTipo[m.tipo]} · v{m.version}</p>
			<h1>{m.nombre}</h1>
		</div>
	</div>
	<p class="desc">{m.descripcion}</p>
	{#if m.disponible}
		<p class="estado incluida">Disponible</p>
	{:else}
		<p class="estado no-incluida">{m.porQueNo}</p>
	{/if}
</div>

<div class="rejilla">
	<div class="principal">
		{#if m.ficha}
			<section class="panel bloque">
				<h2>Qué detecta</h2>
				<p>{m.ficha.detecta}</p>
				<h2>Dónde ponerla</h2>
				<p>{m.ficha.donde}</p>
				{#if m.ficha.requisitos.length}
					<h2>Qué necesita</h2>
					<ul>
						{#each m.ficha.requisitos as r (r)}<li>{r}</li>{/each}
					</ul>
				{/if}
			</section>

			<section class="panel bloque">
				<h2>Cómo instalarla</h2>
				{#if m.ficha.instalacion.automatica}
					<h3>Automática</h3>
					<p>Desde esta consola: eliges el sensor y sus ajustes, y el sensor la despliega solo.</p>
					{#if m.disponible && opera && m.desplegable}
						<a class="boton principal" href={resolve('/trampas/nueva/[modulo]', { modulo: m.id })}
							>Desplegar</a
						>
					{/if}
				{/if}
				{#if m.ficha.instalacion.manual?.length}
					<h3>Manual</h3>
					<p>Para que lo haga tu administrador, paso a paso:</p>
					<ol>
						{#each m.ficha.instalacion.manual as paso, i (i)}<li>{paso}</li>{/each}
					</ol>
					{#if !m.ficha.instalacion.automatica && m.disponible && opera && m.desplegable}
						<p>
							Desde esta consola: eliges dónde, y la consola te prepara los pasos con tus datos, en
							un script y en un documento para el control de cambios.
						</p>
						<a class="boton principal" href={resolve('/trampas/nueva/[modulo]', { modulo: m.id })}
							>Desplegar</a
						>
					{/if}
				{/if}
				{#if !m.disponible}
					<p class="nota">
						{m.porQueNo}: puedes ver cómo funciona, pero no desplegarla. Habla con SeguridadSI si te
						interesa.
					</p>
				{/if}
			</section>
		{:else}
			<section class="panel bloque">
				<p>{m.descripcion}</p>
				{#if m.disponible && opera && m.desplegable}
					<a class="boton principal" href={resolve('/trampas/nueva/[modulo]', { modulo: m.id })}
						>Desplegar</a
					>
				{/if}
			</section>
		{/if}
	</div>

	<aside class="panel ficha">
		<h2>Ficha técnica</h2>
		{#if m.ajustes.length}
			<p class="eyebrow">Se puede ajustar</p>
			<p>{m.ajustes.join(' · ')}</p>
		{/if}
		{#if m.puertos.length}
			<p class="eyebrow">Puertos de serie</p>
			<p class="mono">{m.puertos.join(', ')}</p>
		{/if}
		{#if m.aislamiento}
			<p class="eyebrow">Aislamiento</p>
			<p>
				{m.aislamiento.salida ? 'Con salida a internet' : 'Sin salida a internet'} ·
				{m.aislamiento.soloLectura ? 'solo lectura' : 'escribible'} ·
				<span class="mono">{m.aislamiento.cpu} CPU, {m.aislamiento.memoriaMb} MB</span>
			</p>
		{/if}
		{#if m.imagen}
			<p class="eyebrow">Imagen</p>
			<p class="mono imagen">{m.imagen}</p>
		{/if}
		{#if m.procedencia}
			<p class="eyebrow">Procedencia</p>
			<p>
				<a href={m.procedencia.url} rel="noreferrer noopener" target="_blank"
					>{m.procedencia.proyecto}</a
				>
				· {m.procedencia.licencia} · revisado y firmado por SeguridadSI
			</p>
			{#if credito}
				<p class="credito">{credito}</p>
			{/if}
		{/if}
	</aside>
</div>

<style>
	.volver {
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.cabecera {
		margin: 14px 0 20px;
	}

	.titulo {
		display: flex;
		align-items: center;
		gap: 14px;
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

	.estado {
		margin: 10px 0 0;
		font-size: 13px;
		font-weight: 600;
	}

	.incluida {
		color: var(--ok);
	}

	.no-incluida {
		color: var(--ink-3);
	}

	.rejilla {
		display: grid;
		gap: 16px;
		grid-template-columns: minmax(0, 1fr) 340px;
		align-items: start;
	}

	@media (max-width: 900px) {
		.rejilla {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.principal {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.bloque,
	.ficha {
		padding: 18px 20px 20px;
	}

	h2 {
		font-size: 15px;
		font-weight: 600;
		margin: 16px 0 4px;
	}

	h2:first-child {
		margin-top: 0;
	}

	h3 {
		font-size: 13.5px;
		font-weight: 600;
		margin: 12px 0 2px;
	}

	.bloque p,
	.bloque li {
		font-size: 14px;
		color: var(--ink-2);
	}

	.bloque .boton {
		margin-top: 8px;
	}

	.nota {
		margin-top: 14px;
		font-size: 13px;
		color: var(--ink-3);
	}

	.ficha .eyebrow {
		margin: 14px 0 4px;
	}

	.ficha p {
		margin: 0;
		font-size: 13px;
	}

	.ficha .credito {
		margin-top: 6px;
		font-size: 12px;
		color: var(--ink-3);
	}

	.imagen {
		font-size: 11.5px;
		word-break: break-all;
		color: var(--ink-2);
	}
</style>
