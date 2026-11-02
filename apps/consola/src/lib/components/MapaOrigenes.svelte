<script lang="ts">
	/*
	 * Orígenes del Resumen: el mapa del mundo por país y el de España por
	 * comunidad autónoma (solo las IP españolas). Los dos se pinchan.
	 */
	import mundo from '$lib/mapa/mundo.json';
	import espana from '$lib/mapa/espana.json';
	import { COMUNIDADES, nombrePais } from '$lib/formato';
	import BotonPlegar from './BotonPlegar.svelte';
	import MapaCalor, { type IpDeZona } from './MapaCalor.svelte';

	type Zona = { eventos: number; ips: number; top: IpDeZona[] };
	type Org = { organizacion: string; asn: number | null; eventos: number; ips: number };

	let {
		paises,
		regiones,
		organizaciones,
		dias
	}: {
		paises: (Zona & { pais: string })[];
		regiones: (Zona & { region: string })[];
		organizaciones: Org[];
		dias: number;
	} = $props();

	const dibujoMundo = {
		ancho: mundo.ancho,
		alto: mundo.alto,
		zonas: mundo.paises.map((p) => ({ id: p.a2, d: p.d }))
	};
	const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

	/* Cada mapa se pliega por su cuenta (BotonPlegar lo recuerda en el navegador). */
	let plegado = $state({ mundo: false, espana: false });
</script>

{#snippet atribucion()}
	Últimos {dias} días, solo IP públicas. Geolocalización:
	<a href="https://db-ip.com" rel="noreferrer noopener" target="_blank">DB-IP</a> (CC BY 4.0).
{/snippet}

{#snippet redes()}
	{#if organizaciones.length}
		<section>
			<h3 class="redes">Desde qué redes</h3>
			<ol class="redes">
				{#each organizaciones as o (o.organizacion)}
					<li>
						<span class="nombre" title={o.asn ? `AS${o.asn}` : ''}>{o.organizacion}</span>
						<span class="n mono" title={plural(o.ips, 'IP', 'IP')}>{o.eventos}</span>
					</li>
				{/each}
			</ol>
		</section>
	{/if}
{/snippet}

<div class="cab-mapa">
	<h3>Mapa mundial</h3>
	<BotonPlegar id="resumen-mapa-mundo" titulo="Mapa mundial" bind:plegado={plegado.mundo} />
</div>
{#if !plegado.mundo}
	<MapaCalor
		dibujo={dibujoMundo}
		zonas={paises.map((p) => ({ ...p, id: p.pais }))}
		nombre={nombrePais}
		titulo="Países"
		etiqueta="Mapa de orígenes por país"
		vacio="Ningún evento desde IP públicas."
		pie={atribucion}
		resumen={redes}
	/>
{/if}

<div class="separador"></div>

<div class="cab-mapa">
	<h3>Mapa de España</h3>
	<BotonPlegar id="resumen-mapa-espana" titulo="Mapa de España" bind:plegado={plegado.espana} />
</div>
{#if !plegado.espana}
	<MapaCalor
		dibujo={espana}
		zonas={regiones.map((r) => ({ ...r, id: r.region }))}
		nombre={(id) => COMUNIDADES[id] ?? id}
		titulo="España, por comunidad"
		etiqueta="Mapa de orígenes en España por comunidad autónoma"
		vacio="Ningún evento desde IP españolas."
		pie={atribucion}
	/>
{/if}

<style>
	.separador {
		border-top: 1px solid var(--line);
	}

	.cab-mapa {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}

	.separador + .cab-mapa {
		margin-top: 16px;
	}

	.cab-mapa h3 {
		font-size: 14px;
		font-weight: 600;
	}

	h3.redes {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ink-3);
		margin: 0 0 6px;
	}

	ol.redes {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	ol.redes li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 5px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}

	ol.redes li:last-child {
		border-bottom: none;
	}

	.nombre {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.n {
		color: var(--ink-2);
	}
</style>
