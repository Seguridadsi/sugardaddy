<script lang="ts">
	import mundo from '$lib/mapa/mundo.json';
	import { nombrePais } from '$lib/formato';

	type Pais = { pais: string; eventos: number; ips: number };
	type Org = { organizacion: string; asn: number | null; eventos: number; ips: number };

	let { paises, organizaciones, dias }: { paises: Pais[]; organizaciones: Org[]; dias: number } =
		$props();

	const porPais = $derived(new Map(paises.map((p) => [p.pais, p])));
	const maximo = $derived(Math.max(1, ...paises.map((p) => p.eventos)));
	/* Escala logarítmica: un país con 5 eventos se ve aunque otro tenga 5.000. */
	const intensidad = (n: number) => 0.25 + 0.75 * (Math.log(1 + n) / Math.log(1 + maximo));
	const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
</script>

<div class="geo">
	<figure>
		<svg viewBox="0 0 {mundo.ancho} {mundo.alto}" role="img" aria-label="Mapa de orígenes">
			{#each mundo.paises as p (p.a2)}
				{@const d = porPais.get(p.a2)}
				<path
					d={p.d}
					class:tocado={!!d}
					style={d ? `fill-opacity: ${intensidad(d.eventos)}` : undefined}
					><title
						>{nombrePais(p.a2)}{d
							? ` · ${plural(d.eventos, 'evento', 'eventos')} desde ${plural(d.ips, 'IP', 'IP')}`
							: ''}</title
					></path
				>
			{/each}
		</svg>
		<figcaption>
			Últimos {dias} días, solo IP públicas. Geolocalización:
			<a href="https://db-ip.com" rel="noreferrer noopener" target="_blank">DB-IP</a> (CC BY 4.0).
		</figcaption>
	</figure>

	<div class="listas">
		<section>
			<h3>Países</h3>
			{#if paises.length === 0}
				<p class="vacio">Ningún evento desde IP públicas.</p>
			{/if}
			<ol>
				{#each paises.slice(0, 6) as p (p.pais)}
					<li>
						<span class="mono codigo">{p.pais}</span>
						<span class="nombre">{nombrePais(p.pais)}</span>
						<span class="n mono" title={plural(p.ips, 'IP', 'IP')}>{p.eventos}</span>
					</li>
				{/each}
			</ol>
		</section>
		{#if organizaciones.length}
			<section>
				<h3>Desde qué redes</h3>
				<ol>
					{#each organizaciones as o (o.organizacion)}
						<li>
							<span class="nombre" title={o.asn ? `AS${o.asn}` : ''}>{o.organizacion}</span>
							<span class="n mono" title={plural(o.ips, 'IP', 'IP')}>{o.eventos}</span>
						</li>
					{/each}
				</ol>
			</section>
		{/if}
	</div>
</div>

<style>
	.geo {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
		gap: 18px;
		padding: 16px 18px;
	}

	@media (max-width: 860px) {
		.geo {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	figure {
		margin: 0;
		min-width: 0;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
	}

	path {
		fill: var(--surface-2);
		stroke: var(--line);
		stroke-width: 0.5;
	}

	path.tocado {
		fill: var(--accent);
	}

	path:hover {
		stroke: var(--ink-2);
		stroke-width: 1;
	}

	figcaption {
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	h3 {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ink-3);
		margin: 0 0 6px;
	}

	.listas section + section {
		margin-top: 16px;
	}

	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 5px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}

	li:last-child {
		border-bottom: none;
	}

	.codigo {
		font-size: 11.5px;
		color: var(--ink-3);
		width: 22px;
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

	.vacio {
		font-size: 13px;
		color: var(--ink-3);
		margin: 0;
	}
</style>
