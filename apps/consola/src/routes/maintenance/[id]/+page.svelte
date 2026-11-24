<!--
	El resumen de una ventana de mantenimiento (lib/server/mantenimiento.ts): qué
	avisos de salud se callaron, qué eventos hubo y qué seguía parado al acabar.
-->
<script lang="ts">
	import { fechaHoraLarga } from '$lib/fechas-pantalla';
	import { nombreSeveridad } from '$lib/formato';

	let { data } = $props();
	const r = $derived(data.resumen);
	const numero = (n: number) => n.toLocaleString('en-GB');
	const cuando = (iso: string) => fechaHoraLarga(iso);
	const ORDEN = ['critica', 'alta', 'media', 'baja'];
	const QUE: Record<string, string> = {
		'salud.sensor-sin-latido': 'Sensor not responding',
		'salud.silencio': 'Sensor silent',
		'salud.trampa-caida': 'Honeypot not working properly',
		'salud.trampa-parada': 'Honeypot stopped',
		'salud.disco-casi-lleno': 'Sensor disk almost full',
		'salud.disco-lleno': 'Sensor disk full',
		'salud.memoria': 'Sensor out of memory',
		'salud.cpu': 'Sensor at full CPU',
		'salud.trampa-reinicios': 'Honeypot restarting',
		'salud.trampa-callada': 'Honeypot gone quiet',
		'salud.cola-atascada': 'Sensor events not reaching the console',
		'salud.cola-descartando': 'Sensor discarding events',
		'salud.reloj': 'Sensor clock wrong'
	};
</script>

<svelte:head>
	<title>Maintenance "{data.nombre}" — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<a class="volver" href="/maintenance">← Maintenance windows</a>
		<h1>Maintenance "{data.nombre}"</h1>
		<p class="desc">
			{cuando(data.desde)} → {cuando(data.hasta)} · {data.alcance} · scheduled by {data.quien}{data.cerradaPor
				? ` · ended early by ${data.cerradaPor}`
				: ''}
		</p>
		{#if data.nota}<p class="desc">{data.nota}</p>{/if}
	</div>
	<button class="boton" onclick={() => window.print()}>Print</button>
</div>

{#if data.enCurso}
	<p class="aviso">
		Still in progress: this is everything so far. The summary arrives when it ends.
	</p>
{/if}

<div class="cifras">
	<div class="panel"><b>{numero(r.eventos)}</b><span>events (they alerted as usual)</span></div>
	<div class="panel"><b>{numero(r.callados.length)}</b><span>health alerts held back</span></div>
	{#if !data.enCurso}
		<div class="panel">
			<b>{numero(r.sinVolver.length)}</b><span>sensors still not responding at the end</span>
		</div>
	{/if}
</div>

{#if !data.enCurso && r.sinVolver.length}
	<p class="aviso">
		Still not responding when the window ended: {r.sinVolver.map((x) => x.nombre).join(', ')}. Their
		health alerts are back on. <a href="/sensors">Sensors</a>
	</p>
{/if}

<div class="rejilla">
	<section class="panel bloque">
		<h2>Health alerts held back</h2>
		{#if r.callados.length}
			<table>
				<thead><tr><th>What</th><th>Which</th><th>Since</th></tr></thead>
				<tbody>
					{#each r.callados as c (c.clave)}
						<tr>
							<td>{QUE[c.codigo] ?? c.codigo}</td>
							<td>{c.nombre}</td>
							<td class="mono">{cuando(c.desde)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="vacio">None.</p>
		{/if}
	</section>

	<section class="panel bloque">
		<h2>Events during the window</h2>
		{#if r.eventos}
			<table>
				<tbody>
					{#each ORDEN.filter((x) => r.porSeveridad[x]) as sev (sev)}
						<tr
							><td>{nombreSeveridad(sev)}</td><td class="num mono">{numero(r.porSeveridad[sev])}</td
							></tr
						>
					{/each}
				</tbody>
			</table>
			<h3>By honeypot</h3>
			<table>
				<tbody>
					{#each r.porTrampa as t (t.trampa)}
						<tr><td>{t.nombre}</td><td class="num mono">{numero(t.eventos)}</td></tr>
					{/each}
				</tbody>
			</table>
		{:else}
			<p class="vacio">None.</p>
		{/if}
	</section>
</div>

<style>
	.cabecera {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
		margin-bottom: 16px;
	}

	h1 {
		font-size: clamp(22px, 4.5vw, 30px);
		font-weight: 700;
		margin: 3px 0 4px;
	}

	h2 {
		font-size: 15px;
		font-weight: 600;
		margin: 0 0 8px;
	}

	h3 {
		font-size: 13.5px;
		font-weight: 600;
		margin: 14px 0 4px;
	}

	.desc {
		color: var(--ink-2);
		margin: 2px 0;
		font-size: 13.5px;
	}

	.aviso {
		color: var(--warn);
		font-weight: 600;
		font-size: 13.5px;
	}

	.cifras {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}

	.cifras .panel {
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.cifras b {
		font-size: 22px;
	}

	.cifras span {
		color: var(--ink-3);
		font-size: 12.5px;
	}

	.rejilla {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 16px;
		margin-bottom: 16px;
	}

	.bloque {
		padding: 14px 16px 16px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13.5px;
	}

	th,
	td {
		text-align: left;
		padding: 5px 6px;
		border-bottom: 1px solid var(--line);
	}

	th {
		color: var(--ink-3);
		font-weight: 600;
		font-size: 12px;
	}

	.num {
		text-align: right;
	}

	.vacio {
		color: var(--ink-3);
		font-size: 13.5px;
	}

	@media print {
		.boton,
		.volver {
			display: none;
		}
	}
</style>
