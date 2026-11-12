<!--
	Un sitio del mapa: su centro (la máquina de un sensor, un servidor, una web) y
	sus trampas conectadas. Cada nodo es un botón: al pincharlo se abre su detalle
	y se resalta lo que tiene unido. La colocación sale de lib/mapa-despliegue-grafo.ts.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import LogoTrampa from '$lib/components/LogoTrampa.svelte';
	import { etiquetaTrampa } from '$lib/mapa-despliegue';
	import {
		FAMILIA,
		HOJA,
		extremos,
		vecinosDe,
		type AristaGrafo,
		type Grafo,
		type NodoGrafo
	} from '$lib/mapa-despliegue-grafo';
	import GlifoEstado from './GlifoEstado.svelte';

	type Props = {
		grafo: Grafo;
		elegido: string | null;
		onelegir: (id: string) => void;
		/* Lo que va dentro del nodo central. */
		centro?: Snippet;
		/* Lo que necesita la línea que llega de la consola. */
		rama?: string;
		pildora?: string;
		claseCentro?: string;
	};
	let { grafo, elegido, onelegir, centro, rama, pildora, claseCentro = '' }: Props = $props();

	/* La etiqueta de una señal, cerca de quien la manda: las que llegan al mismo nodo no se pisan. */
	const POSICION_ETIQUETA = 0.32;

	const posicion = $derived(new Map(grafo.nodos.map((n) => [n.id, n])));
	const resaltados = $derived(elegido && posicion.has(elegido) ? vecinosDe(grafo, elegido) : null);
	const apagado = (id: string) => resaltados !== null && !resaltados.has(id);
	const apagada = (a: AristaGrafo) =>
		resaltados !== null && (!resaltados.has(a.de) || !resaltados.has(a.a));

	const estructura = $derived(grafo.aristas.filter((a) => !a.relacion));
	const relaciones = $derived(
		grafo.aristas.flatMap((a) => {
			const e = a.relacion ? extremos(grafo, a) : null;
			return e ? [{ a, ...e }] : [];
		})
	);

	/* La punta de una flecha, en el extremo de una señal. */
	function punta(d: { x: number; y: number }, h: { x: number; y: number }) {
		const n = Math.hypot(h.x - d.x, h.y - d.y) || 1;
		const ux = (h.x - d.x) / n;
		const uy = (h.y - d.y) / n;
		const L = 10;
		const W = 5.5;
		return [
			`${h.x},${h.y}`,
			`${h.x - ux * L - uy * W},${h.y - uy * L + ux * W}`,
			`${h.x - ux * L + uy * W},${h.y - uy * L - ux * W}`
		].join(' ');
	}

	const titulo = (n: Extract<NodoGrafo, { tipo: 'trampa' }>) =>
		`${n.trampa.nombre} · ${n.trampa.etiqueta}`;
</script>

<div class="grafo" data-cuadro style:width="{grafo.ancho}px" style:height="{grafo.alto}px">
	<svg class="aristas" width={grafo.ancho} height={grafo.alto} aria-hidden="true">
		{#each estructura as a (`${a.de}>${a.a}`)}
			{@const de = posicion.get(a.de)}
			{@const hacia = posicion.get(a.a)}
			{#if de && hacia}
				<line
					class="arista {a.clase}"
					class:apagada={apagada(a)}
					x1={de.x}
					y1={de.y}
					x2={hacia.x}
					y2={hacia.y}
				/>
			{/if}
		{/each}
		{#each relaciones as r (`${r.a.de}>${r.a.a}`)}
			<g class="senal {r.a.clase}" class:apagada={apagada(r.a)}>
				<line x1={r.desde.x} y1={r.desde.y} x2={r.hasta.x} y2={r.hasta.y} />
				<polygon points={punta(r.desde, r.hasta)} />
			</g>
		{/each}
	</svg>

	{#each relaciones as r (`${r.a.de}>${r.a.a}`)}
		<span
			class="etiqueta-senal {r.a.clase}"
			class:apagada={apagada(r.a)}
			style:left="{r.desde.x + (r.hasta.x - r.desde.x) * POSICION_ETIQUETA}px"
			style:top="{r.desde.y + (r.hasta.y - r.desde.y) * POSICION_ETIQUETA}px"
			title={r.a.relacion?.destino ?? undefined}>{r.a.relacion?.texto}</span
		>
	{/each}

	{#each grafo.nodos as n (n.id)}
		{#if n.tipo === 'centro'}
			<button
				class="nodo centro {claseCentro}"
				class:elegido={elegido === n.id}
				class:apagado={apagado(n.id)}
				style:left="{n.x - grafo.tamano.ancho / 2}px"
				style:top="{n.y - grafo.tamano.alto / 2}px"
				style:width="{grafo.tamano.ancho}px"
				style:height="{grafo.tamano.alto}px"
				data-centro
				data-rama={rama}
				data-pildora={pildora}
				onclick={(e) => {
					e.stopPropagation();
					onelegir(n.id);
				}}
			>
				{@render centro?.()}
			</button>
		{:else if n.tipo === 'familia'}
			<button
				class="nodo familia"
				class:elegido={elegido === n.id}
				class:apagado={apagado(n.id)}
				style:left="{n.x - FAMILIA.circulo / 2}px"
				style:top="{n.y - FAMILIA.circulo / 2}px"
				title="{n.nombre}: {n.trampas.length} honeypots"
				onclick={(e) => {
					e.stopPropagation();
					onelegir(n.id);
				}}
			>
				<span class="disco-familia"><LogoTrampa pictograma={n.familia} /></span>
				{#if n.conNombre}<span class="nombre-familia">{n.nombre}</span>{/if}
			</button>
		{:else}
			{@const e = etiquetaTrampa(n.trampa)}
			<button
				class="nodo trampa {n.trampa.estado}"
				class:elegido={elegido === n.id}
				class:apagado={apagado(n.id)}
				style:left="{n.x - HOJA.ancho / 2}px"
				style:top="{n.y - HOJA.circulo / 2}px"
				style:width="{HOJA.ancho}px"
				title={titulo(n)}
				onclick={(ev) => {
					ev.stopPropagation();
					onelegir(n.id);
				}}
			>
				<span class="disco">
					<LogoTrampa procedencia={n.trampa.procedencia} pictograma={n.trampa.pictograma} />
					{#if n.trampa.eventos > 0}<span class="cuenta">{n.trampa.eventos}</span>{/if}
					{#if n.trampa.estado !== 'comprobada'}
						<span class="sello"><GlifoEstado estado={n.trampa.estado} /></span>
					{/if}
				</span>
				<span class="arriba">{e.arriba}</span>
				<span class="abajo {e.clase}">{e.abajo}</span>
			</button>
		{/if}
	{/each}
</div>

<style>
	.grafo {
		position: relative;
		flex: none;
	}

	.aristas {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.arista {
		stroke-width: 2;
		opacity: 0.75;
		transition: opacity 0.15s;
	}

	.arista.estructura {
		stroke: var(--line-strong);
		opacity: 1;
	}

	.arista.ok {
		stroke: var(--ok);
	}

	.arista.pendiente {
		stroke: var(--s-media);
	}

	.arista.aviso {
		stroke: var(--warn);
	}

	.arista.mal {
		stroke: var(--crit);
		stroke-dasharray: 5 4;
	}

	.senal line {
		stroke-width: 2.2;
		stroke-dasharray: 6 5;
	}

	.senal.senal line {
		stroke: var(--ink-2);
	}

	.senal.senal polygon {
		fill: var(--ink-2);
	}

	.senal.rele line {
		stroke: var(--s-media);
		stroke-dasharray: 2 6;
		stroke-linecap: round;
	}

	.senal.rele polygon {
		fill: var(--s-media);
	}

	.apagada,
	.apagado {
		opacity: 0.18;
	}

	.etiqueta-senal {
		position: absolute;
		z-index: 3;
		max-width: 170px;
		padding: 1px 8px;
		transform: translate(-50%, -50%);
		overflow: hidden;
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		background: var(--bg);
		font-size: 11.5px;
		color: var(--ink-2);
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: opacity 0.15s;
	}

	.etiqueta-senal.rele {
		border-color: var(--s-media);
	}

	.nodo {
		position: absolute;
		z-index: 2;
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.nodo:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 8px;
	}

	/* El centro */
	.nodo.centro {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		padding: 8px 12px;
		border: 1.5px solid var(--marca);
		border-radius: 13px;
		background: var(--surface);
		text-align: left;
		box-shadow: var(--shadow);
	}

	.nodo.centro.caido {
		border-color: var(--crit);
	}

	.nodo.centro.puerta {
		border-color: var(--s-media);
	}

	.nodo.centro.de-sitio {
		border: 1px solid var(--line-strong);
	}

	.nodo.centro:hover {
		background: var(--surface-2);
	}

	.nodo.centro.elegido {
		box-shadow: 0 0 0 3px var(--accent);
	}

	/* Un tipo de servicio */
	.nodo.familia {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 36px;
	}

	.disco-familia {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		overflow: hidden;
		border: 1.5px solid var(--line-strong);
		border-radius: 50%;
		background: var(--surface-2);
	}

	.disco-familia :global(.logo) {
		transform: scale(0.82);
	}

	.nodo.familia.elegido .disco-familia {
		box-shadow: 0 0 0 3px var(--accent);
	}

	.nombre-familia {
		margin-top: 2px;
		padding: 0 5px;
		border-radius: 5px;
		background: var(--bg);
		font-size: 11px;
		font-weight: 600;
		color: var(--ink-2);
		white-space: nowrap;
	}

	/* Una trampa */
	.nodo.trampa {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.disco {
		position: relative;
		display: grid;
		place-items: center;
		width: 46px;
		height: 46px;
		border: 2.5px solid var(--ok);
		border-radius: 50%;
		background: var(--surface);
		transition: box-shadow 0.15s;
	}

	.nodo.trampa:hover .disco {
		background: var(--surface-2);
	}

	.nodo.trampa.elegido .disco {
		box-shadow: 0 0 0 3px var(--accent);
	}

	.colocada .disco {
		border-color: var(--s-media);
	}

	.degradada .disco,
	.por-colocar .disco {
		border-color: var(--warn);
	}

	.sin-contacto .disco {
		border-color: var(--crit);
		border-style: dashed;
	}

	.parada .disco,
	.retirando .disco {
		border-color: var(--ink-3);
	}

	.cuenta {
		position: absolute;
		top: -6px;
		right: -8px;
		min-width: 18px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--marca);
		font: 700 10.5px/18px var(--font-mono);
		color: var(--marca-ink);
	}

	.sello {
		position: absolute;
		right: -4px;
		bottom: -3px;
		display: grid;
		place-items: center;
		width: 17px;
		height: 17px;
		border-radius: 50%;
		background: var(--bg);
	}

	/* Con el fondo del sitio: las líneas pasan por detrás y el texto se sigue leyendo. */
	.arriba,
	.abajo {
		padding: 0 3px;
		border-radius: 3px;
		background: var(--bg);
	}

	.arriba {
		margin-top: 3px;
		max-width: 100%;
		overflow: hidden;
		font-size: 11.5px;
		line-height: 1.2;
		color: var(--ink-2);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.abajo {
		max-width: 100%;
		font-size: 12px;
		line-height: 1.2;
	}

	.abajo.puerto {
		max-width: none;
		font: 600 12.5px/1.2 var(--font-mono);
		white-space: nowrap;
	}

	.abajo.propia {
		font: 600 12px/1.2 var(--font-mono);
		color: var(--accent);
	}

	/* Un nombre largo se corta a dos líneas: entero, en su detalle. */
	.abajo.nombre {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
</style>
