<script lang="ts">
	import ListaEventos from '$lib/components/ListaEventos.svelte';
	import { haceCuanto, horaLarga, nombreAccion, textoGeo } from '$lib/formato';
	import { AVISO_IP_MOTOR } from '$lib/capacidades';

	let { data } = $props();

	const geos = $derived(data.geo ? { [data.ip]: data.geo } : {});
	const nombreTrampa = (id: string) => data.nombres[id] ?? id;
</script>

<svelte:head>
	<title>{data.ip} — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<a class="volver" href="/eventos">← Eventos</a>
		<h1 class="mono">
			{data.ip}
			<span class="sev sev-{data.peor}">{data.peor}</span>
			{#if data.geo?.tor}<span class="tag tor">Tor</span>{/if}
		</h1>
		{#if data.geo}<p class="geo">{textoGeo(data.geo)}</p>{/if}
	</div>
	<div class="acciones">
		{#if !data.oculta}
			<a class="csv" href="/eventos/reglas?criterio=ip&valor={encodeURIComponent(data.ip)}"
				>Crear regla de triaje</a
			>
		{/if}
		<a class="csv" href="/eventos?origen={encodeURIComponent(data.ip)}">Ver en la lista →</a>
	</div>
</div>

{#if data.oculta}
	<p class="aviso">{AVISO_IP_MOTOR}</p>
{/if}

<section class="cifras">
	<div class="cifra">
		<span class="n mono">{data.total}</span>
		<span class="et">{data.total === 1 ? 'evento' : 'eventos'}</span>
	</div>
	<div class="cifra">
		<span class="n mono">{data.trampas.length}</span>
		<span class="et">{data.trampas.length === 1 ? 'trampa tocada' : 'trampas tocadas'}</span>
	</div>
	<div class="cifra ancha">
		<span class="et">Primera vez</span>
		<span class="cuando">{horaLarga(data.primera)} · {haceCuanto(data.primera, data.ahora)}</span>
	</div>
	<div class="cifra ancha">
		<span class="et">Última vez</span>
		<span class="cuando">{horaLarga(data.ultima)} · {haceCuanto(data.ultima, data.ahora)}</span>
	</div>
</section>

<div class="dos">
	<section class="panel">
		<h2>Trampas</h2>
		<ul class="desglose">
			{#each data.trampas as t (t.id)}
				<li>
					<a href="/eventos?origen={encodeURIComponent(data.ip)}&trampa={t.id}"
						>{nombreTrampa(t.id)}</a
					>
					<span class="mono">{t.n}</span>
				</li>
			{/each}
		</ul>
	</section>
	<section class="panel">
		<h2>Acciones</h2>
		<ul class="desglose">
			{#each data.acciones as a (a.accion)}
				<li>
					<span>{nombreAccion[a.accion] ?? a.accion}</span>
					<span class="mono">{a.n}</span>
				</li>
			{/each}
		</ul>
	</section>
</div>

<section class="panel">
	<h2 class="conborde">Últimos eventos{#if data.total > data.recientes.length}<small> · {data.recientes.length} de {data.total}</small>{/if}</h2>
	<ListaEventos
		eventos={data.recientes}
		nombres={data.nombres}
		modulos={data.modulos}
		{geos}
		ahora={data.ahora}
	/>
</section>

<style>
	.cabecera {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.volver {
		display: inline-block;
		margin-bottom: 6px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
	}

	.volver:hover {
		color: var(--ink);
	}

	h1 {
		font-size: clamp(22px, 5vw, 30px);
		font-weight: 700;
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.geo {
		margin: 6px 0 0;
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.acciones {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.csv {
		white-space: nowrap;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: 6px 13px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
	}

	.csv:hover {
		background: var(--surface-2);
		color: var(--ink);
	}

	.sev {
		font-size: 12px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 4px;
	}

	.tag {
		font-size: 11px;
		font-weight: 600;
		padding: 2px 7px;
		border-radius: 4px;
	}

	.tor {
		color: var(--warn);
		background: color-mix(in oklab, var(--warn) 16%, transparent);
	}

	.aviso {
		margin: 0 0 16px;
		padding: 10px 14px;
		border-radius: var(--r-sm);
		font-size: 13px;
		color: var(--warn);
		border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line));
	}

	.cifras {
		display: grid;
		grid-template-columns: repeat(2, auto) 1fr 1fr;
		gap: 12px;
		margin-bottom: 16px;
	}

	.cifra {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px 16px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
	}

	.cifra .n {
		font-size: 24px;
		font-weight: 700;
		color: var(--ink);
	}

	.cifra .et {
		font-size: 11.5px;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.cifra .cuando {
		font-size: 13px;
		color: var(--ink);
	}

	@media (max-width: 760px) {
		.cifras {
			grid-template-columns: 1fr 1fr;
		}
	}

	.dos {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
		margin-bottom: 16px;
	}

	@media (max-width: 760px) {
		.dos {
			grid-template-columns: 1fr;
		}
	}

	h2 {
		font-size: 13px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-3);
		margin: 0 0 4px;
		padding: 14px 17px 0;
	}

	h2.conborde {
		padding-bottom: 12px;
		border-bottom: 1px solid var(--line);
		margin-bottom: 0;
	}

	h2 small {
		text-transform: none;
		letter-spacing: 0;
		color: var(--ink-3);
		font-weight: 400;
	}

	.desglose {
		list-style: none;
		margin: 0;
		padding: 4px 0 8px;
	}

	.desglose li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 17px;
		font-size: 13.5px;
	}

	.desglose a {
		color: var(--ink);
		text-decoration: none;
	}

	.desglose a:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.desglose .mono {
		color: var(--ink-2);
	}
</style>
