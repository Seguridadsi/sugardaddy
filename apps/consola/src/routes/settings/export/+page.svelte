<script lang="ts">
	import { page } from '$app/state';
	import { pestanaDe } from '$lib/pestanas';
	import { fechaHora } from '$lib/fechas-pantalla';
	import MenuAjustes from '$lib/components/MenuAjustes.svelte';
	import Pestanas from '$lib/components/Pestanas.svelte';

	let { data } = $props();

	/* Descargar (configuración) por un lado; las anteriores y cómo comprobarlas (datos), por otro. */
	const PESTANAS = [
		{ id: 'export', texto: 'Export' },
		{ id: 'history', texto: 'History' },
		{ id: 'verify', texto: 'Verify an export' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));

	const SECCIONES: Record<string, string> = {
		events: 'Events',
		incidents: 'Incidents and response',
		audit: 'Audit log',
		configuration: 'Configuration',
		users: 'Users and access',
		settings: 'Settings'
	};
	const porSeccion = $derived(
		Object.entries(SECCIONES).map(([id, titulo]) => ({
			id,
			titulo,
			ficheros: data.secciones.filter((s) => s.seccion === id)
		}))
	);

	let pedida = $state(false);

	const tamano = (b: number | null) =>
		b === null
			? ''
			: b < 1024 * 1024
				? `${Math.max(1, Math.round(b / 1024))} KB`
				: `${(b / 1024 / 1024).toFixed(1)} MB`;
</script>

<svelte:head>
	<title>Export — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Settings</h1>
</div>

<MenuAjustes actual="export" />

<p class="ayuda intro">
	Download everything this console holds — events, incidents, the audit log with its hash chain and
	seals, and your configuration — in open formats (JSON Lines, and CEF for events), signed by this
	node. Use it to keep your own records, move to another tool or hand it to an auditor. Secrets are
	never included.
</p>

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Export sections" />

{#if pestana === 'export'}
	<section class="panel bloque">
		<h2>Full export</h2>
		{#if data.soporte}
			<p class="error" role="alert">
				Support sessions cannot export your data. Sign in with your own administrator account.
			</p>
		{:else}
			<p class="ayuda">
				One <code class="mono">.tar.gz</code> file ({data.formato}). This node has about
				{data.eventosAprox.toLocaleString('en')} events: large exports take a few minutes and the download
				starts right away. Every export is recorded in the audit log with the archive's SHA-256.
			</p>
			<form method="POST" action="/settings/export/archive" onsubmit={() => (pedida = true)}>
				<button class="boton">Download full export</button>
			</form>
			{#if pedida}
				<p class="ayuda" role="status">
					Your browser is downloading the archive. When it finishes, check it in the
					<a href="?tab=history">History</a> tab.
				</p>
			{/if}
		{/if}
	</section>

	<section class="panel bloque">
		<h2>What is inside</h2>
		{#each porSeccion as s (s.id)}
			{#if s.ficheros.length}
				<h3>{s.titulo}</h3>
				<ul>
					{#each s.ficheros as f (f.nombre)}
						<li>
							<code class="mono">{s.id}/{f.nombre}-0001.jsonl</code>{#if f.cef}
								and <code class="mono">.cef</code>{/if}{#if f.quitadas.length}
								<small> — without {f.quitadas.join(', ')}</small>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/each}
		<p class="ayuda">
			Plus <code class="mono">manifest.json</code> (every file with its row count and SHA-256),
			<code class="mono">manifest.sig.json</code>, <code class="mono">SHA256SUMS</code> and a
			<code class="mono">README.txt</code>. Not exported: sessions, one-time codes, delivery queues
			and cached enrichment.
		</p>
	</section>
{:else if pestana === 'history'}
	<section class="panel">
		{#if data.historial.length === 0}
			<p class="vacio">No exports yet.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>When</th>
						<th>By</th>
						<th>Result</th>
						<th>Archive SHA-256</th>
					</tr>
				</thead>
				<tbody>
					{#each data.historial as h (h.id)}
						<tr>
							<td>{fechaHora(h.cuando)}</td>
							<td>{h.quien}</td>
							<td>
								{#if h.ok}
									Completed{#if h.bytes !== null}<small
											>{tamano(h.bytes)}{#if h.eventos !== null}, {h.eventos.toLocaleString('en')} events{/if}</small
										>{/if}
								{:else}
									Failed<small>{h.motivo}</small>
								{/if}
							</td>
							<td class="mono hash">
								{#if h.archivo}{h.archivo}<small>manifest {h.manifiesto}</small>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
{:else}
	<section class="panel bloque">
		<h2>Verify an export</h2>
		<ol>
			<li>
				Compare <code class="mono">sha256sum sugardaddy-export-*.tar.gz</code> with the archive SHA-256
				in the History tab.
			</li>
			<li>
				Unpack it and run <code class="mono">sha256sum -c SHA256SUMS</code>: every file must say OK.
			</li>
			<li>
				Check the node's signature over <code class="mono">manifest.json</code> with
				<code class="mono">public-key.pem</code>, as <code class="mono">README.txt</code> explains. Community
				nodes sign with their own secret, which only the node can check.
			</li>
			<li>
				Check the audit log chain: for each row,
				<code class="mono">sha256(hash_anterior + canonica)</code> equals
				<code class="mono">hash</code>, and the last hash matches
				<code class="mono">audit/head.json</code>.
			</li>
		</ol>
	</section>
{/if}

<style>
	.cabecera {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	.intro {
		max-width: 760px;
	}

	.bloque {
		margin-bottom: 16px;
		padding: 18px 20px 20px;
		max-width: 760px;
	}

	.bloque h2 {
		font-size: 16px;
		font-weight: 600;
	}

	.bloque h3 {
		font-size: 14px;
		font-weight: 600;
		margin: 14px 0 4px;
	}

	.bloque ul,
	.bloque ol {
		margin: 0;
		padding-left: 20px;
		display: grid;
		gap: 4px;
	}

	.vacio {
		padding: 16px 20px;
		margin: 0;
	}

	td small {
		display: block;
		color: var(--muted);
	}

	.hash {
		word-break: break-all;
		font-size: 12px;
	}
</style>
