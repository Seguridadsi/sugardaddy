<!--
	La pestaña «Health» de Sensores (docs/diseno/salud.md): la máquina de cada
	sensor ahora, la serie del que se mira (24 horas o 7 días) y cómo corre cada
	una de sus trampas. Los avisos salen por Alerts and SIEM, con los umbrales
	que se ven aquí.
-->
<script lang="ts">
	import { page } from '$app/state';
	import SerieSalud from './SerieSalud.svelte';
	import { haceCuanto } from '$lib/formato';

	type Ultima = {
		cuando: string;
		cpu: number | null;
		carga1: number | null;
		cpus: number | null;
		memoriaTotal: number | null;
		memoriaLibre: number | null;
		discoTotal: number | null;
		discoLibre: number | null;
		trampas: { id: string; enMarcha: boolean; estado: string; reinicios: number; desde?: string }[];
	};
	let {
		salud,
		sensores,
		ahora,
		community = false
	}: {
		salud: {
			sensor: string | null;
			rango: '24h' | '7d';
			ultimas: Record<string, Ultima>;
			serie: {
				cuando: string;
				cpu: number | null;
				memoria: number | null;
				disco: number | null;
				carga1: number | null;
			}[];
			nombresTrampa: Record<string, string>;
		};
		sensores: { id: string; nombre: string }[];
		ahora: number;
		/* En Community no hay Avisos y SIEM: la nota dice que es de Cloud. */
		community?: boolean;
	} = $props();

	const usado = (total: number | null, libre: number | null) =>
		total && libre !== null ? Math.min(1, Math.max(0, 1 - libre / total)) : null;
	const pct = (f: number | null) => (f === null ? '—' : `${Math.round(f * 100)} %`);
	const bytes = (n: number | null) => {
		if (n === null) return '—';
		const u = ['B', 'KB', 'MB', 'GB', 'TB'];
		let i = 0;
		let v = n;
		while (v >= 1024 && i < u.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
	};
	/* Rojo desde el umbral del aviso, ámbar un poco antes. */
	const nivel = (f: number | null, aviso: number) =>
		f === null ? '' : f >= aviso ? 'mal' : f >= aviso - 0.1 ? 'ojo' : 'bien';

	const enlace = (cambios: Record<string, string>) => {
		const p = new URLSearchParams(page.url.searchParams);
		p.set('tab', 'health');
		for (const [k, v] of Object.entries(cambios)) p.set(k, v);
		return `${page.url.pathname}?${p}`;
	};

	const elegido = $derived(sensores.find((x) => x.id === salud.sensor));
	const ultima = $derived(salud.sensor ? salud.ultimas[salud.sensor] : undefined);
	const desde = $derived(ahora - (salud.rango === '24h' ? 1 : 7) * 86_400_000);
	const serie = (campo: 'cpu' | 'memoria' | 'disco', escala: number) =>
		salud.serie.map((p) => ({
			cuando: p.cuando,
			valor: p[campo] === null ? null : (p[campo] as number) * escala
		}));
	const estadoTrampa: Record<string, string> = {
		running: 'Running',
		restarting: 'Restarting',
		exited: 'Stopped',
		dead: 'Dead',
		created: 'Not started',
		paused: 'Paused',
		removing: 'Being removed',
		unhealthy: 'Not answering its health check',
		unknown: 'Unknown'
	};
</script>

<section class="panel">
	<table>
		<thead>
			<tr>
				<th>Sensor</th>
				<th class="num">CPU</th>
				<th class="num">Memory</th>
				<th class="num">Disk</th>
				<th class="num">Honeypots running</th>
				<th>Last sample</th>
			</tr>
		</thead>
		<tbody>
			{#each sensores as x (x.id)}
				{@const u = salud.ultimas[x.id]}
				{@const mem = u ? usado(u.memoriaTotal, u.memoriaLibre) : null}
				{@const disco = u ? usado(u.discoTotal, u.discoLibre) : null}
				<tr class:elegido={x.id === salud.sensor}>
					<td><a href={enlace({ sensor: x.id })}>{x.nombre}</a></td>
					{#if u}
						<td class="num {nivel(u.cpu === null ? null : u.cpu / 100, 0.9)}"
							>{u.cpu === null ? '—' : `${Math.round(u.cpu)} %`}</td
						>
						<td class="num {nivel(mem, 0.9)}">{pct(mem)}</td>
						<td class="num {nivel(disco, 0.85)}">{pct(disco)}</td>
						<td class="num">{u.trampas.filter((t) => t.enMarcha).length} / {u.trampas.length}</td>
						<td>{haceCuanto(u.cuando, ahora)}</td>
					{:else}
						<td colspan="5" class="tenue"
							>No recent sample: the sensor is down or runs an older version.</td
						>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</section>

{#if elegido}
	<section class="panel detalle">
		<div class="titulo">
			<h2>{elegido.nombre}</h2>
			<nav aria-label="Period">
				<a href={enlace({ range: '24h' })} aria-current={salud.rango === '24h' ? 'page' : undefined}
					>24 hours</a
				>
				<a href={enlace({ range: '7d' })} aria-current={salud.rango === '7d' ? 'page' : undefined}
					>7 days</a
				>
			</nav>
		</div>
		{#if ultima}
			<p class="tenue">
				{ultima.cpus ?? '?'} processors · load {ultima.carga1 ?? '—'} · memory {bytes(
					ultima.memoriaLibre
				)} free of {bytes(ultima.memoriaTotal)} · disk {bytes(ultima.discoLibre)} free of {bytes(
					ultima.discoTotal
				)}
			</p>
		{/if}
		<div class="series">
			<SerieSalud
				titulo="CPU"
				puntos={serie('cpu', 1)}
				umbral={90}
				{desde}
				hasta={ahora}
				actual={ultima?.cpu == null ? '—' : `${Math.round(ultima.cpu)} %`}
			/>
			<SerieSalud
				titulo="Memory used"
				puntos={serie('memoria', 100)}
				umbral={90}
				{desde}
				hasta={ahora}
				actual={ultima ? pct(usado(ultima.memoriaTotal, ultima.memoriaLibre)) : '—'}
			/>
			<SerieSalud
				titulo="Disk used"
				puntos={serie('disco', 100)}
				umbral={85}
				{desde}
				hasta={ahora}
				actual={ultima ? pct(usado(ultima.discoTotal, ultima.discoLibre)) : '—'}
			/>
		</div>

		{#if ultima?.trampas.length}
			<h3>Honeypots on this sensor</h3>
			<table>
				<thead>
					<tr>
						<th>Honeypot</th>
						<th>State</th>
						<th class="num">Restarts</th>
						<th>Running since</th>
					</tr>
				</thead>
				<tbody>
					{#each ultima.trampas as t (t.id)}
						<tr>
							<td>{salud.nombresTrampa[t.id] ?? t.id}</td>
							<td class={t.enMarcha ? 'bien' : 'mal'}>{estadoTrampa[t.estado] ?? t.estado}</td>
							<td class="num">{t.reinicios}</td>
							<td>{t.desde ? haceCuanto(t.desde, ahora).replace(' ago', '') : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		<p class="tenue nota">
			{community ? 'With Cloud, ' : ''}Alerts and SIEM sends a health alert when the disk passes 85
			% (and again at 95 %), when less than 10 % of memory is available for 5 minutes, when the CPU
			stays above 90 % for 15 minutes, when a honeypot restarts 3 times in half an hour, and when a
			honeypot that used to receive events receives none for 48 hours. Samples are kept for 7 days.
		</p>
	</section>
{/if}

<style>
	/* Las tablas como las de Sensores (sus estilos son de su página). */
	.panel:has(> table) {
		overflow-x: auto;
		margin-bottom: 16px;
	}
	.detalle {
		padding: 16px 18px;
	}
	.detalle h2 {
		margin: 0;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13.5px;
	}
	th {
		text-align: left;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-3);
		padding: 12px 16px 9px;
		border-bottom: 1px solid var(--line);
	}
	td {
		padding: 11px 16px;
		border-bottom: 1px solid var(--line);
		vertical-align: middle;
	}
	tr:last-child td {
		border-bottom: none;
	}
	.detalle table {
		border: 1px solid var(--line);
	}
	.titulo {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.titulo nav a {
		margin-left: 14px;
		font-size: 13.5px;
		color: var(--ink-2);
		text-decoration: none;
		border-bottom: 2px solid transparent;
	}
	.titulo nav a[aria-current='page'] {
		color: var(--ink);
		border-bottom-color: var(--accent);
	}
	.series {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 12px;
		margin: 14px 0 18px;
	}
	h3 {
		margin: 18px 0 8px;
		font-size: 15px;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	tr.elegido td {
		background: var(--surface-2);
	}
	.tenue {
		color: var(--ink-3);
	}
	.nota {
		margin-top: 14px;
		font-size: 13px;
	}
	.bien {
		color: var(--ok);
	}
	.ojo {
		color: var(--warn);
	}
	.mal {
		color: var(--crit);
		font-weight: 600;
	}
</style>
