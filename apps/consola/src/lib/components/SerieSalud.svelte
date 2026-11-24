<!--
	Una serie de la pestaña «Health» (salud-maquina.ts): una línea de 0 a 100 %
	con la raya del umbral del aviso. SVG a mano, sin librerías: la consola va
	en máquinas de clientes y cada pieza más es algo más que mantener.
-->
<script lang="ts">
	let {
		titulo,
		puntos,
		umbral,
		desde,
		hasta,
		actual
	}: {
		titulo: string;
		/* cuando (ISO) y valor de 0 a 100, o null donde no hubo muestra. */
		puntos: { cuando: string; valor: number | null }[];
		umbral?: number;
		desde: number;
		hasta: number;
		actual: string;
	} = $props();

	const ANCHO = 600;
	const ALTO = 120;
	const x = (iso: string) => ((Date.parse(iso) - desde) / Math.max(1, hasta - desde)) * ANCHO;
	const y = (v: number) => ALTO - (Math.min(100, Math.max(0, v)) / 100) * ALTO;

	/* Una línea por tramo seguido: donde faltan muestras (sensor caído), un hueco. */
	const tramos = $derived.by(() => {
		const hueco = (hasta - desde) / 60;
		const r: string[] = [];
		let actualTramo: string[] = [];
		let antes: number | null = null;
		for (const p of puntos) {
			const t = Date.parse(p.cuando);
			if (p.valor === null || (antes !== null && t - antes > hueco)) {
				if (actualTramo.length) r.push(actualTramo.join(' '));
				actualTramo = [];
			}
			if (p.valor !== null) actualTramo.push(`${x(p.cuando).toFixed(1)},${y(p.valor).toFixed(1)}`);
			antes = t;
		}
		if (actualTramo.length) r.push(actualTramo.join(' '));
		return r;
	});
	const pasa = $derived(
		umbral !== undefined && puntos.some((p) => p.valor !== null && p.valor >= umbral)
	);
</script>

<figure class="serie">
	<figcaption><span>{titulo}</span><strong>{actual}</strong></figcaption>
	{#if tramos.length}
		<svg
			viewBox="0 0 {ANCHO} {ALTO}"
			preserveAspectRatio="none"
			role="img"
			aria-label="{titulo}: {actual}"
		>
			<line class="eje" x1="0" x2={ANCHO} y1={y(50)} y2={y(50)} />
			{#if umbral !== undefined}
				<line class="umbral" x1="0" x2={ANCHO} y1={y(umbral)} y2={y(umbral)} />
			{/if}
			{#each tramos as t, i (i)}
				<polyline class:pasa points={t} />
			{/each}
		</svg>
	{:else}
		<p class="vacio">No samples in this period.</p>
	{/if}
</figure>

<style>
	.serie {
		margin: 0;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
	}
	figcaption {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
		font-size: 13px;
		color: var(--ink-2);
	}
	figcaption strong {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	svg {
		display: block;
		width: 100%;
		height: 120px;
		overflow: visible;
	}
	polyline {
		fill: none;
		stroke: var(--ink);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}
	polyline.pasa {
		stroke: var(--warn);
	}
	.eje {
		stroke: var(--line);
		stroke-dasharray: 2 4;
		vector-effect: non-scaling-stroke;
	}
	.umbral {
		stroke: var(--crit);
		stroke-dasharray: 6 4;
		opacity: 0.6;
		vector-effect: non-scaling-stroke;
	}
	.vacio {
		margin: 0;
		height: 120px;
		display: grid;
		place-items: center;
		color: var(--ink-3);
		font-size: 13px;
	}
</style>
