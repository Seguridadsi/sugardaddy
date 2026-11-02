<script lang="ts" module>
	export type IpDeZona = {
		ip: string;
		eventos: number;
		organizacion: string | null;
		ultimo: string;
	};
	export type DatosZona = { id: string; eventos: number; ips: number; top: IpDeZona[] };
	export type Dibujo = {
		ancho: number;
		alto: number;
		zonas: { id: string; d: string }[];
		recuadro?: { x: number; y: number; ancho: number; alto: number };
	};
</script>

<script lang="ts">
	/*
	 * Un mapa de calor de orígenes (países o comunidades) y, al lado, la lista.
	 * Pinchar una zona, en el mapa o en la lista, enseña a la derecha sus IP con
	 * más eventos, cada una con su perfil (/eventos/ip). Sin selección, la lista
	 * de zonas y lo que se pase en `resumen`.
	 */
	import type { Snippet } from 'svelte';
	import { haceCuanto } from '$lib/formato';

	let {
		dibujo,
		zonas,
		nombre,
		titulo,
		etiqueta,
		vacio,
		pie,
		resumen
	}: {
		dibujo: Dibujo;
		zonas: DatosZona[];
		nombre: (id: string) => string;
		titulo: string;
		etiqueta: string;
		vacio: string;
		pie: Snippet;
		resumen?: Snippet;
	} = $props();

	let elegida = $state<string | null>(null);
	const ahora = Date.now();

	const porId = $derived(new Map(zonas.map((z) => [z.id, z])));
	const sel = $derived(elegida ? (porId.get(elegida) ?? null) : null);
	const maximo = $derived(Math.max(1, ...zonas.map((z) => z.eventos)));
	/* Escala logarítmica: una zona con 5 eventos se ve aunque otra tenga 5.000. */
	const intensidad = (n: number) => 0.25 + 0.75 * (Math.log(1 + n) / Math.log(1 + maximo));
	const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
	const elegir = (id: string) => (elegida = elegida === id ? null : id);
</script>

<div class="geo">
	<figure>
		<svg viewBox="0 0 {dibujo.ancho} {dibujo.alto}" role="img" aria-label={etiqueta}>
			{#if dibujo.recuadro}
				<rect
					class="recuadro"
					x={dibujo.recuadro.x}
					y={dibujo.recuadro.y}
					width={dibujo.recuadro.ancho}
					height={dibujo.recuadro.alto}
				/>
			{/if}
			{#each dibujo.zonas as z (z.id)}
				{@const d = porId.get(z.id)}
				{#if d}
					<path
						d={z.d}
						class="tocado"
						class:elegida={elegida === z.id}
						style="fill-opacity: {intensidad(d.eventos)}"
						role="button"
						tabindex="0"
						aria-label="{nombre(z.id)}: {plural(d.eventos, 'evento', 'eventos')}"
						aria-pressed={elegida === z.id}
						onclick={() => elegir(z.id)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								elegir(z.id);
							}
						}}
						><title
							>{nombre(z.id)} · {plural(d.eventos, 'evento', 'eventos')} desde {plural(
								d.ips,
								'IP',
								'IP'
							)}</title
						></path
					>
				{:else}
					<path d={z.d}><title>{nombre(z.id)}</title></path>
				{/if}
			{/each}
		</svg>
		<figcaption>{@render pie()}</figcaption>
	</figure>

	<div class="lado">
		{#if sel}
			<button type="button" class="volver" onclick={() => (elegida = null)}>← {titulo}</button>
			<h3 class="titulo-zona">{nombre(sel.id)}</h3>
			<p class="cifras">
				{plural(sel.eventos, 'evento', 'eventos')} desde {plural(sel.ips, 'IP', 'IP')}
				{#if sel.ips > sel.top.length}<span>· las {sel.top.length} con más eventos</span>{/if}
			</p>
			<ol class="ips">
				{#each sel.top as i (i.ip)}
					<li>
						<a class="mono" href="/eventos/ip/{encodeURIComponent(i.ip)}" title="Perfil de la IP"
							>{i.ip}</a
						>
						<span class="n mono">{i.eventos}</span>
						<small class="org" title={i.organizacion ?? ''}
							>{i.organizacion ?? 'red desconocida'} · {haceCuanto(i.ultimo, ahora)}</small
						>
					</li>
				{/each}
			</ol>
		{:else}
			<section>
				<h3>{titulo}</h3>
				{#if zonas.length === 0}
					<p class="vacio">{vacio}</p>
				{/if}
				<ol>
					{#each zonas.slice(0, 8) as z (z.id)}
						<li>
							<button type="button" class="zona" onclick={() => elegir(z.id)}>
								<span class="nombre">{nombre(z.id)}</span>
								<span class="n mono" title={plural(z.ips, 'IP', 'IP')}>{z.eventos}</span>
							</button>
						</li>
					{/each}
				</ol>
				{#if zonas.length}<p class="pista">Pincha una zona para ver sus IP.</p>{/if}
			</section>
			{@render resumen?.()}
		{/if}
	</div>
</div>

<style>
	.geo {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr);
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
		max-height: 460px;
	}

	path {
		fill: var(--surface-2);
		stroke: var(--line);
		stroke-width: 0.5;
	}

	/* El foco se ve en el borde de la zona, no en un recuadro alrededor. */
	path.tocado {
		fill: var(--accent);
		cursor: pointer;
		outline: none;
	}

	path.tocado:hover,
	path.tocado:focus-visible {
		stroke: var(--ink-2);
		stroke-width: 1;
	}

	path.elegida {
		stroke: var(--ink);
		stroke-width: 1.6;
	}

	.recuadro {
		fill: none;
		stroke: var(--line-strong);
		stroke-width: 0.8;
	}

	figcaption {
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.lado {
		min-width: 0;
	}

	h3 {
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ink-3);
		margin: 0 0 6px;
	}

	h3.titulo-zona {
		font-size: 16px;
		text-transform: none;
		letter-spacing: 0;
		color: var(--ink);
		margin: 6px 0 2px;
	}

	.cifras {
		margin: 0 0 8px;
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.cifras span {
		color: var(--ink-3);
	}

	.lado :global(section + section) {
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
		flex-wrap: wrap;
		gap: 2px 8px;
		padding: 5px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}

	li:last-child {
		border-bottom: none;
	}

	.ips {
		max-height: 380px;
		overflow-y: auto;
	}

	.ips a {
		flex: 1;
		min-width: 0;
	}

	.org {
		flex-basis: 100%;
		color: var(--ink-3);
		font-size: 11.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	button.zona {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	button.zona:hover .nombre {
		text-decoration: underline;
	}

	.volver {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
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

	.vacio,
	.pista {
		font-size: 12.5px;
		color: var(--ink-3);
		margin: 6px 0 0;
	}
</style>
