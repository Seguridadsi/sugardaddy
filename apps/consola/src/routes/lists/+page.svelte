<script lang="ts">
	import { enhance } from '$app/forms';
	import { sinVaciar } from '$lib/guardar';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { diaCorto } from '$lib/fechas-pantalla';
	import { haceCuanto } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const blanca = $derived(data.lista === 'blanca');
	const roles = $derived(page.data.usuario?.roles ?? []);
	/* Una IP o red de confianza: el alta en Orígenes conocidos, ya rellena. */
	const alta = $derived.by(() => {
		const f = form as { aOrigenes?: string; motivo?: string } | null;
		return f?.aOrigenes
			? `/sources?nuevo=${encodeURIComponent(f.aOrigenes)}&nombre=${encodeURIComponent(f.motivo ?? '')}`
			: null;
	});
</script>

<svelte:head>
	<title>Lists — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Lists</h1>
</div>

<nav class="pestanas">
	<a href={resolve('/lists')} aria-current={!blanca ? 'page' : undefined}>
		Blocklist <span class="mono">{data.cuentas.negra}</span>
	</a>
	<a href="{resolve('/lists')}?lista=blanca" aria-current={blanca ? 'page' : undefined}>
		Allowlist <span class="mono">{data.cuentas.blanca}</span>
	</a>
	<a href="{resolve('/lists')}?lista=tor" aria-current={data.lista === 'tor' ? 'page' : undefined}>
		Tor <span class="mono">{data.cuentas.tor}</span>
	</a>
</nav>

{#if data.lista === 'tor'}
	<div class="rejilla">
		<section class="panel">
			{#if data.tor}
				<p class="tor-cabecera">
					<b class="mono">{data.tor.ips.length}</b> Tor exit nodes, from the public list of the
					<a href={data.tor.fuente} rel="noreferrer noopener" target="_blank">Tor Project</a>.
					Updated {haceCuanto(data.tor.emitida, Date.now())}; {data.operador} refreshes it every day.
				</p>
				<ul class="ips mono">
					{#each data.tor.ips as ip (ip)}<li>{ip}</li>{/each}
				</ul>
			{:else}
				<p class="tor-cabecera">
					The list has not arrived yet. It comes from Central with the next heartbeat.
				</p>
			{/if}
		</section>
		<div class="lateral">
			<form class="panel bloque" method="POST" action="?/tor" use:enhance={sinVaciar}>
				<h2>What to do with it</h2>
				<p class="nota">
					Events arriving from Tor are always flagged. Sending the list to your firewalls is your
					decision: it blocks Tor entirely, including anyone using it legitimately.
				</p>
				<label class="interruptor">
					<input type="checkbox" name="edl" checked={data.usoTor.edl} />
					<span>
						<b>Include it in the list your firewalls read</b>
						<small>The external dynamic list (EDL). Your allowlist still takes precedence.</small>
					</span>
				</label>
				{#if form?.guardadoTor}<p class="guardado" role="status">Saved.</p>{/if}
				{#if puede(roles, 'listas')}<button class="boton">Save</button>{/if}
			</form>
		</div>
	</div>
{:else}
	{#if blanca && data.origenes}
		<p class="nota-origenes">
			Trusted IPs and networks (scanners, monitoring, administrators) are under
			<a href="/sources">Known sources</a>{data.pasadas === 1
				? ', including the one that was here'
				: data.pasadas
					? `, including the ${data.pasadas} that were here`
					: ''}. Only domains remain on the allowlist.
		</p>
	{/if}
	<div class="rejilla">
		<section class="panel">
			<table>
				<thead>
					<tr>
						<th>Value</th>
						<th>Scope</th>
						<th>Reason</th>
						<th>Expires</th>
						<th>Added by</th>
					</tr>
				</thead>
				<tbody>
					{#each data.entradas as l (l.valor + l.ambito)}
						<tr class:nuevo={form?.anadido === l.valor}>
							<td class="mono valor" title={l.valor}>{l.valor}</td>
							<td
								><span class="tag" class:on={l.ambito === 'global'}
									>{l.ambito === 'global' ? 'Global' : 'Local'}</span
								></td
							>
							<td>{l.motivo}</td>
							<td
								class="mono fecha"
								class:caducada={l.caduca && new Date(l.caduca).getTime() < data.ahora}
								>{l.caduca
									? new Date(l.caduca).getTime() < data.ahora
										? 'expired'
										: diaCorto(l.caduca)
									: 'never'}</td
							>
							<td class="quien">{l.quien}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<div class="lateral">
			{#if puede(roles, 'listas')}
				<form class="panel bloque" method="POST" action="?/anadir" use:enhance>
					<h2>Add to the local {blanca ? 'allowlist' : 'blocklist'}</h2>
					{#if blanca}
						<p class="cuidado">
							{data.origenes
								? "Response never blocks a domain listed here, and it is never added to your firewalls' list."
								: 'Anything added here becomes invisible: no alerts and no responses.'} It is recorded
							in the audit log under your name.
						</p>
					{/if}
					<input type="hidden" name="lista" value={data.lista} />
					<label for="valor">{blanca && data.origenes ? 'Domain' : 'IP, network or domain'}</label>
					<input
						id="valor"
						name="valor"
						class="mono"
						required
						placeholder="10.20.0.0/24 · malo.example.com"
						value={form?.valor ?? ''}
					/>
					<label for="motivo">Reason</label>
					<input id="motivo" name="motivo" required value={form?.motivo ?? ''} />
					<label for="dias">Expires in</label>
					<select id="dias" name="dias">
						<option value="0">Never</option>
						<option value="1">1 day</option>
						<option value="7" selected={!blanca}>7 days</option>
						<option value="30">30 days</option>
					</select>
					{#if form?.error}
						<p class="error" role="alert">
							{form.error}
							{#if alta}<a href={alta}>Add it there</a>{/if}
						</p>
					{/if}
					<button class="boton principal">Add</button>
				</form>
			{/if}
		</div>
	</div>
{/if}

<style>
	.cabecera {
		margin-bottom: 16px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.nota-origenes {
		font-size: 13.5px;
		color: var(--ink-2);
		margin: 0 0 12px;
		max-width: 80ch;
	}

	.pestanas {
		display: flex;
		gap: 4px;
		margin-bottom: 14px;
	}

	.pestanas a {
		padding: 7px 14px;
		border-radius: 99px;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
	}

	.pestanas a span {
		color: var(--ink-3);
		margin-left: 4px;
	}

	.pestanas a[aria-current='page'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.rejilla {
		display: grid;
		gap: 16px;
		grid-template-columns: minmax(0, 1fr) 320px;
		align-items: start;
	}

	@media (max-width: 1208px) {
		.rejilla {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.panel:has(table) {
		overflow-x: auto;
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
		padding: 10px 16px;
		border-bottom: 1px solid var(--line);
	}

	tr:last-child td {
		border-bottom: none;
	}

	tr.nuevo td {
		background: var(--accent-soft);
	}

	.valor {
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.quien,
	.fecha {
		color: var(--ink-2);
		white-space: nowrap;
	}

	.fecha.caducada {
		color: var(--crit);
		font-style: italic;
	}

	.lateral {
		display: grid;
		gap: 16px;
	}

	.bloque {
		padding: 16px 18px 18px;
	}

	.bloque h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.bloque .boton {
		margin-top: 16px;
	}

	.cuidado {
		margin: 10px 0 0;
		padding: 9px 12px;
		border-radius: var(--r-sm);
		font-size: 12.5px;
		background: color-mix(in oklab, var(--warn) 12%, var(--surface));
		color: var(--warn);
	}

	.error {
		margin: 10px 0 0;
		font-size: 13px;
		color: var(--crit);
	}

	.guardado {
		margin: 10px 0 0;
		font-size: 13px;
		color: var(--ok);
	}

	.interruptor {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin-top: 14px;
		font-weight: 400;
		color: var(--ink);
	}

	.interruptor input {
		width: auto;
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.interruptor span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.interruptor b {
		font-size: 13.5px;
	}

	.interruptor small {
		font-size: 12px;
		color: var(--ink-3);
	}

	.tor-cabecera {
		margin: 0;
		padding: 14px 18px;
		font-size: 13.5px;
		border-bottom: 1px solid var(--line);
	}

	.ips {
		list-style: none;
		margin: 0;
		padding: 12px 18px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 4px 16px;
		font-size: 12.5px;
		color: var(--ink-2);
		max-height: 520px;
		overflow-y: auto;
	}

	.nota {
		font-size: 13px;
		color: var(--ink-3);
		margin: 4px 0 10px;
	}
</style>
