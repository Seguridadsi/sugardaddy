<!--
	Las trampas de un equipo del mapa: trampa, servicio, puerto y eventos de las
	últimas 24 horas. Una fila por puerto. Con muchas, se enseñan las primeras
	(las que tienen problemas o eventos, que van delante) y el resto al pedirlo.
	Al buscar se enseñan todas las que han quedado.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { enumerar, type TrampaMapa } from '$lib/mapa-despliegue';
	import GlifoEstado from './GlifoEstado.svelte';

	type Props = {
		trampas: TrampaMapa[];
		/* Buscando o filtrando: sin límite. */
		todas?: boolean;
		/* Decir la ruta de cada trampa: la del sistema no la dice ya su tarjeta. */
		conRuta?: boolean;
	};
	let { trampas, todas = false, conRuta = false }: Props = $props();

	const LIMITE = 8;
	let abierta = $state(false);
	const visibles = $derived(todas || abierta ? trampas : trampas.slice(0, LIMITE));
	const ocultas = $derived(trampas.length - visibles.length);
</script>

{#if trampas.length}
	<div class="tabla">
		<table class="trampas">
			<thead>
				<tr>
					<th class="col-glifo"><span class="oculto">Status</span></th>
					<th>Decoy</th>
					<th class="col-servicio">Service</th>
					<th class="col-puerto">Port</th>
					<th class="col-eventos" title="Events in the last 24 hours">24 h</th>
				</tr>
			</thead>
			{#each visibles as t (t.id)}
				<tbody class:problema={t.problema}>
					{#each t.puertos.length ? t.puertos : [null] as p, i (p?.puerto ?? 'sin')}
						<tr>
							<td class="col-glifo">
								{#if i === 0}<GlifoEstado estado={t.estado} titulo={t.etiqueta} />{/if}
							</td>
							<td class="nombre">
								{#if i === 0}<a href={resolve('/decoys/[id]', { id: t.id })}>{t.nombre}</a>{/if}
								<span class="servicio-corto"
									>{p ? p.servicio : t.conIpPropia ? 'Own IP' : t.clase}</span
								>
							</td>
							<td class="col-servicio servicio">
								{p ? p.servicio : t.conIpPropia ? 'Own IP' : t.clase}
							</td>
							<td class="col-puerto puerto" class:sin={!p} class:rango={p?.puerto.includes('-')}>
								{#if p}{p.puerto}{:else if !t.conIpPropia}no port{/if}
							</td>
							<td class="col-eventos eventos" class:con={t.eventos > 0}>
								{#if i === 0}
									{#if t.eventos > 0}
										<a href="{resolve('/events')}?trampa={encodeURIComponent(t.id)}">{t.eventos}</a>
									{:else}0{/if}
								{/if}
							</td>
						</tr>
					{/each}
					{#if t.modulo}<tr><td></td><td colspan="4" class="detalle">{t.modulo}</td></tr>{/if}
					{#if t.conIpPropia}
						<tr>
							<td></td>
							<td colspan="4" class="detalle propia" class:falta={!t.ipPropia}>
								{t.ipPropia ?? 'No IP assigned yet'}
							</td>
						</tr>
					{/if}
					{#if t.ubicacion}
						<tr><td></td><td colspan="4" class="detalle mono">{t.ubicacion}</td></tr>
					{/if}
					{#each t.puertos.filter((x) => x.escuchaEn) as x (x.puerto)}
						<tr>
							<td></td>
							<td colspan="4" class="detalle"
								>{x.puerto} listens on <b class="mono">{x.escuchaEn}</b></td
							>
						</tr>
					{/each}
					{#if conRuta && t.ruta}
						<tr>
							<td></td>
							<td colspan="4" class="detalle">
								{t.ruta.texto}
								{#if t.ruta.destino}<b class="mono" class:rele={t.ruta.rele}>{t.ruta.destino}</b
									>{/if}
							</td>
						</tr>
					{/if}
					{#if t.recibeDe.length}
						<tr>
							<td></td>
							<td colspan="4" class="detalle">Receives the signal from {enumerar(t.recibeDe)}</td>
						</tr>
					{/if}
					<!-- Sin contacto lo dice ya la tarjeta de su sensor: no se repite en cada trampa. -->
					{#if t.problema && t.motivo && t.estado !== 'sin-contacto'}
						<tr><td></td><td colspan="4" class="detalle aviso">{t.motivo}</td></tr>
					{/if}
				</tbody>
			{/each}
		</table>
		{#if ocultas > 0}
			<button class="mas" onclick={() => (abierta = true)}>
				View {ocultas === 1 ? 'one more decoy' : `${ocultas} more decoys`}
			</button>
		{:else if abierta && !todas && trampas.length > LIMITE}
			<button class="mas" onclick={() => (abierta = false)}>View less</button>
		{/if}
	</div>
{/if}

<style>
	/* Se adapta al ancho de la tarjeta, no al de la ventana: un sistema colgado es más estrecho. */
	.tabla {
		container-type: inline-size;
	}

	.trampas {
		width: 100%;
		margin-top: 9px;
		border-top: 1px solid var(--line);
		border-collapse: collapse;
		table-layout: fixed;
	}

	th {
		padding: 6px 0 3px;
		font: 600 11px var(--font-body);
		letter-spacing: 0.02em;
		text-align: left;
		color: var(--ink-3);
	}

	td {
		padding: 3px 0;
		vertical-align: baseline;
		overflow-wrap: break-word;
	}

	tbody tr:first-child td {
		padding-top: 5px;
	}

	tbody tr:last-child td {
		padding-bottom: 4px;
	}

	.col-glifo {
		width: 18px;
	}

	.col-servicio {
		width: 72px;
	}

	.col-puerto {
		width: 84px;
	}

	.col-eventos {
		width: 30px;
		text-align: right;
		white-space: nowrap;
	}

	.nombre {
		padding-right: 8px;
	}

	.nombre a {
		color: var(--ink);
		text-decoration: none;
	}

	.nombre a:hover {
		text-decoration: underline;
	}

	/* En pantalla estrecha el servicio va debajo del nombre (ver el @media). */
	.servicio-corto {
		display: none;
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.servicio {
		font-size: 13px;
		color: var(--ink-2);
	}

	.puerto {
		font: 500 13.5px var(--font-mono);
		white-space: nowrap;
	}

	/* «30100-30103/tcp» no cabe en la columna: se parte por el guion. */
	.puerto.rango {
		white-space: normal;
	}

	.puerto.sin {
		font: 400 12px var(--font-body);
		color: var(--ink-3);
	}

	.eventos {
		font: 500 13px var(--font-mono);
		color: var(--ink-3);
	}

	.eventos.con,
	.eventos a {
		font-weight: 600;
		color: var(--ink);
	}

	.detalle {
		padding-top: 0;
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.detalle b {
		font-weight: 500;
		color: var(--ink);
	}

	.detalle b.rele {
		color: var(--s-media);
	}

	.detalle.mono {
		font-family: var(--font-mono);
	}

	.detalle.propia {
		font: 500 14px var(--font-mono);
		color: var(--accent);
	}

	.detalle.propia.falta {
		font: 400 12.5px var(--font-body);
		color: var(--warn);
	}

	.detalle.aviso {
		color: var(--warn);
	}

	.mas {
		width: 100%;
		margin-top: 2px;
		padding: 7px 0 3px;
		border: 0;
		border-top: 1px solid var(--line);
		background: none;
		font: 500 13px var(--font-body);
		text-align: left;
		color: var(--ink);
		cursor: pointer;
	}

	.mas:hover {
		text-decoration: underline;
	}

	.oculto {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	/*
	 * Sin sitio para el servicio, va debajo del nombre. La columna se queda sin
	 * ancho en lugar de quitarse: las filas de detalle cuentan con ella.
	 */
	@container (max-width: 345px) {
		.col-servicio {
			width: 0;
			padding: 0;
			overflow: hidden;
			font-size: 0;
		}

		.servicio-corto {
			display: block;
		}
	}
</style>
