<script lang="ts">
	import { resolve } from '$app/paths';
	import EstadoTrampa from '$lib/components/EstadoTrampa.svelte';
	import ListaEventos from '$lib/components/ListaEventos.svelte';
	import MapaOrigenes from '$lib/components/MapaOrigenes.svelte';
	import { textoGeo } from '$lib/formato';
	import { haceCuanto, nombreTipo } from '$lib/formato';
	import { AVISO_IP_MOTOR } from '$lib/capacidades';

	let { data } = $props();

	/* Las que ahora no reciben nada se ven apagadas; una degradada sigue a la vista. */
	const APAGADAS = ['parada', 'por-colocar', 'sin-contacto', 'retirando'];
	/* Dónde escucha solo tiene sentido si está puesta. */
	const PUESTAS = ['comprobada', 'colocada'];
</script>

<svelte:head>
	<title>Resumen — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<p class="eyebrow">Últimas 24 horas</p>
		<h1>Resumen</h1>
	</div>
	<div class="cifras">
		<span><b class="mono">{data.cifras.eventos}</b> eventos</span>
		<span class="crit"><b class="mono">{data.cifras.criticos}</b> críticos</span>
		<span><b class="mono">{data.cifras.origenes}</b> orígenes</span>
		<span title="Activas: comprobadas con un evento real"
			><b class="mono">{data.cifras.activos}/{data.cifras.total}</b> trampas activas</span
		>
	</div>
</div>

<div class="rejilla">
	<section class="panel">
		<header class="titulo">
			<h2>Últimos eventos</h2>
			<a href={resolve('/eventos')}>Ver todos</a>
		</header>
		<ListaEventos
			eventos={data.ultimos}
			nombres={data.nombres}
			modulos={data.modulos}
			geos={data.geos}
			ahora={data.ahora}
		/>
	</section>

	<div class="lateral">
		<section class="panel">
			<header class="titulo"><h2>Orígenes más activos</h2></header>
			<ul class="origenes">
				{#each data.origenes as o (o.ip)}
					<li>
						<span class="ip">
							<span class="mono"
								>{o.ip}{#if o.geo?.tor}<span class="tor" title="Nodo de salida de Tor">Tor</span
									>{/if}{#if o.oculta}<span class="tor" title={AVISO_IP_MOTOR}>IP del motor</span
									>{/if}</span
							>
							{#if o.geo}<small>{textoGeo(o.geo)}</small>{/if}
							{#if o.oculta}<small>no es la de un atacante</small>{/if}
						</span>
						<span class="sev sev-{o.peor}">{o.peor}</span>
						<span class="n mono">{o.eventos}</span>
					</li>
				{/each}
			</ul>
		</section>
	</div>
</div>

<h2 class="seccion">Orígenes</h2>
<section class="panel">
	<MapaOrigenes
		paises={data.geo.paises}
		organizaciones={data.geo.organizaciones}
		dias={data.geo.dias}
	/>
</section>

<h2 class="seccion">Mapa de trampas</h2>
<div class="mapa">
	{#each data.sensores as s (s.id)}
		<section class="panel sensor" class:caido={!s.vivo}>
			<header>
				<div>
					<h3>{s.nombre}</h3>
					{#if s.red}<p class="mono">{s.red}</p>{/if}
				</div>
				<span class="latido" class:mal={!s.vivo}>
					{s.vivo
						? 'en línea'
						: s.ultimoLatido
							? `sin contacto ${haceCuanto(s.ultimoLatido, data.ahora)}`
							: 'nunca ha contactado'}
				</span>
			</header>
			{#if s.avisos.length}
				<!-- El detalle, con lo que hay que hacer, está en Sensores. -->
				<a class="avisos-sensor" href={resolve('/sensores')}>
					{#each s.avisos as a (a.codigo)}
						<span class:grave={a.gravedad === 'error'}>{a.titulo}</span>
					{/each}
				</a>
			{/if}
			<ul>
				{#each s.trampas as x (x.id)}
					<li class:parado={APAGADAS.includes(x.estado.estado)}>
						<span
							class="estado"
							data-peor={x.peor}
							title={x.peor ? `Tocado: ${x.peor}` : 'Sin eventos'}
						></span>
						<span class="nombre">
							<b>{x.nombre}</b>
							<small>
								<EstadoTrampa estado={x.estado} />
								<!-- Una trampa a mano: la recibe este sensor, pero está en su destino. -->
								{#if x.aMano}{' · '}a mano en {x.destino ??
										'su destino'}{:else if PUESTAS.includes(x.estado.estado)}{' · '}<span
										class="mono">{x.donde}</span
									>{/if}
							</small>
						</span>
						<span class="tag">{nombreTipo[x.tipo]}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<style>
	.cabecera {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.cifras {
		display: flex;
		gap: 18px;
		flex-wrap: wrap;
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.cifras b {
		font-size: 17px;
		color: var(--ink);
		margin-right: 4px;
	}

	.cifras .crit b {
		color: var(--crit);
	}

	.rejilla {
		display: grid;
		gap: 16px;
		grid-template-columns: minmax(0, 1fr) 300px;
		align-items: start;
	}

	@media (max-width: 1000px) {
		.rejilla {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.titulo {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding: 14px 17px 10px;
		border-bottom: 1px solid var(--line);
	}

	.titulo h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.titulo a {
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.origenes {
		list-style: none;
		margin: 0;
		padding: 6px 0;
	}

	.origenes li {
		display: grid;
		grid-template-columns: 1fr auto 28px;
		gap: 10px;
		align-items: center;
		padding: 7px 17px;
		font-size: 13.5px;
	}

	.origenes .n {
		text-align: right;
		color: var(--ink-2);
	}

	.seccion {
		font-size: 18px;
		font-weight: 600;
		margin: 30px 0 12px;
	}

	.mapa {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
	}

	.sensor header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 10px;
		padding: 14px 16px 10px;
		border-bottom: 1px solid var(--line);
	}

	.sensor h3 {
		font-size: 15px;
		font-weight: 600;
	}

	.sensor header p {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--ink-3);
	}

	.latido {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ok);
		white-space: nowrap;
	}

	.latido.mal {
		color: var(--crit);
	}

	.caido {
		border-style: dashed;
	}

	.sensor ul {
		list-style: none;
		margin: 0;
		padding: 6px 0;
	}

	.sensor li {
		display: grid;
		grid-template-columns: 10px 1fr auto;
		gap: 11px;
		align-items: center;
		padding: 8px 16px;
	}

	.sensor li.parado {
		opacity: 0.5;
	}

	.estado {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--line-strong);
	}

	.estado[data-peor='baja'] {
		background: var(--s-baja);
	}
	.estado[data-peor='media'] {
		background: var(--s-media);
	}
	.estado[data-peor='alta'] {
		background: var(--s-alta);
	}
	.estado[data-peor='critica'] {
		background: var(--s-critica);
		box-shadow: 0 0 0 4px color-mix(in oklab, var(--s-critica) 25%, transparent);
	}

	.nombre {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.nombre b {
		font-size: 13.5px;
		font-weight: 600;
	}

	.nombre small {
		font-size: 11.5px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ip {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.ip small {
		font-size: 11.5px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.avisos-sensor {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 9px 16px;
		border-bottom: 1px solid var(--line);
		background: color-mix(in oklab, var(--warn) 8%, var(--surface));
		font-size: 12.5px;
		font-weight: 600;
		color: var(--warn);
		text-decoration: none;
	}

	.avisos-sensor .grave {
		color: var(--crit);
	}

	.tor {
		margin-left: 6px;
		white-space: nowrap;
		padding: 0 5px;
		border-radius: 4px;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--warn);
		background: color-mix(in oklab, var(--warn) 16%, transparent);
	}
</style>
