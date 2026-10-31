<script lang="ts">
	import ListaEventos from '$lib/components/ListaEventos.svelte';
	import { haceCuanto, horaLarga, nombreAccion, textoGeo } from '$lib/formato';
	import { AVISO_IP_MOTOR } from '$lib/capacidades';

	let { data } = $props();

	const nombreTrampa = (id: string) => data.nombres[id] ?? id;
	const reglaHref = $derived(
		`/eventos/reglas?criterio=usuario&valor=${encodeURIComponent(data.usuario)}`
	);
	/* Enlace a la lista filtrada por ESTE usuario exacto (no búsqueda libre). */
	const listaUsuario = $derived(`usuario=${encodeURIComponent(data.usuario)}`);
</script>

<svelte:head>
	<title>{data.usuario} — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<a class="volver" href="/eventos">← Eventos</a>
		<h1>
			Usuario <span class="mono">{data.usuario}</span>
			<span class="sev sev-{data.peor}">{data.peor}</span>
		</h1>
	</div>
	<a class="accion" href={reglaHref}>Crear regla de triaje</a>
</div>

<section class="cifras">
	<div class="cifra">
		<span class="n mono">{data.total}</span>
		<span class="et">{data.total === 1 ? 'evento' : 'eventos'}</span>
	</div>
	<div class="cifra">
		<span class="n mono">{data.origenes.length}{data.masOrigenes ? '+' : ''}</span>
		<span class="et">{data.origenes.length === 1 ? 'IP de origen' : 'IPs de origen'}</span>
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
		<h2>IPs de origen</h2>
		<ul class="desglose">
			{#each data.origenes as o (o.ip)}
				<li>
					{#if o.oculta}
						<!-- La IP del motor de contenedores, no la de un atacante: ni enlace ni perfil. -->
						<span class="mono" title={AVISO_IP_MOTOR}>{o.ip}</span>
						<span class="geo motor">IP del motor</span>
					{:else}
						<a class="mono" href="/eventos/ip/{encodeURIComponent(o.ip)}">{o.ip}</a>
						<span class="geo">{o.geo ? textoGeo(o.geo) : ''}</span>
					{/if}
					<span class="mono n">{o.n}</span>
				</li>
			{/each}
		</ul>
	</section>
	<section class="panel">
		<h2>Trampas y acciones</h2>
		<ul class="desglose">
			{#each data.trampas as t (t.id)}
				<li>
					<a href="/eventos?trampa={t.id}&{listaUsuario}">{nombreTrampa(t.id)}</a>
					<span class="mono n">{t.n}</span>
				</li>
			{/each}
			{#each data.acciones as a (a.accion)}
				<li class="accion-fila">
					<span>{nombreAccion[a.accion] ?? a.accion}</span>
					<span class="mono n">{a.n}</span>
				</li>
			{/each}
		</ul>
	</section>
</div>

<section class="panel">
	<h2 class="conborde"
		>Últimos eventos{#if data.total > data.recientes.length}<small>
				· {data.recientes.length} de {data.total}</small
			>{/if}</h2
	>
	<ListaEventos
		eventos={data.recientes}
		nombres={data.nombres}
		modulos={data.modulos}
		geos={data.geosRecientes}
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

	.accion {
		white-space: nowrap;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: 6px 13px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
	}

	.accion:hover {
		background: var(--surface-2);
		color: var(--ink);
	}

	.sev {
		font-size: 12px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 4px;
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
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 17px;
		font-size: 13.5px;
	}

	.desglose .geo {
		flex: 1;
		min-width: 0;
		color: var(--ink-3);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.desglose .geo.motor {
		color: var(--warn);
	}

	.desglose a {
		color: var(--ink);
		text-decoration: none;
	}

	.desglose a:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.desglose .n {
		color: var(--ink-2);
	}
</style>
