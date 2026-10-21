<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { diaCorto, haceCuanto } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const blanca = $derived(data.lista === 'blanca');
	const roles = $derived(page.data.usuario?.roles ?? []);
</script>

<svelte:head>
	<title>Listas — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Listas</h1>
</div>

<nav class="pestanas">
	<a href={resolve('/listas')} aria-current={!blanca ? 'page' : undefined}>
		Lista negra <span class="mono">{data.cuentas.negra}</span>
	</a>
	<a href="{resolve('/listas')}?lista=blanca" aria-current={blanca ? 'page' : undefined}>
		Lista blanca <span class="mono">{data.cuentas.blanca}</span>
	</a>
	<a href="{resolve('/listas')}?lista=tor" aria-current={data.lista === 'tor' ? 'page' : undefined}>
		Tor <span class="mono">{data.cuentas.tor}</span>
	</a>
</nav>

{#if data.lista === 'tor'}
	<div class="rejilla">
		<section class="panel">
			{#if data.tor}
				<p class="tor-cabecera">
					<b class="mono">{data.tor.ips.length}</b> nodos de salida de Tor, de la lista pública del
					<a href={data.tor.fuente} rel="noreferrer noopener" target="_blank">Tor Project</a>.
					Actualizada {haceCuanto(data.tor.emitida, Date.now())}; SeguridadSI la renueva cada día.
				</p>
				<ul class="ips mono">
					{#each data.tor.ips as ip (ip)}<li>{ip}</li>{/each}
				</ul>
			{:else}
				<p class="tor-cabecera">
					Aún no ha llegado la lista. Llega del panel central con el siguiente latido.
				</p>
			{/if}
		</section>
		<div class="lateral">
			<form class="panel bloque" method="POST" action="?/tor" use:enhance>
				<h2>Qué hacer con ella</h2>
				<p class="nota">
					Los eventos que llegan desde Tor se marcan siempre. Llevarla a tus firewalls es decisión
					tuya: bloquea Tor entero, también a quien lo use legítimamente.
				</p>
				<label class="interruptor">
					<input type="checkbox" name="edl" checked={data.usoTor.edl} />
					<span>
						<b>Incluirla en la lista que leen mis firewalls</b>
						<small>La lista externa (EDL). Tu lista blanca sigue mandando.</small>
					</span>
				</label>
				{#if form?.guardadoTor}<p class="guardado" role="status">Guardado.</p>{/if}
				{#if puede(roles, 'listas')}<button class="boton">Guardar</button>{/if}
			</form>
		</div>
	</div>
{:else}
	<div class="rejilla">
		<section class="panel">
			<table>
				<thead>
					<tr>
						<th>Valor</th>
						<th>Ámbito</th>
						<th>Motivo</th>
						<th>Caduca</th>
						<th>Quién</th>
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
							<td class="mono fecha">{l.caduca ? diaCorto(l.caduca) : 'nunca'}</td>
							<td class="quien">{l.quien}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<div class="lateral">
			{#if puede(roles, 'listas')}
				<form class="panel bloque" method="POST" action="?/anadir" use:enhance>
					<h2>Añadir a la lista {data.lista} local</h2>
					{#if blanca}
						<p class="cuidado">
							Lo que entra aquí se vuelve invisible: ni alertas ni respuestas. Queda auditado con tu
							nombre.
						</p>
					{/if}
					<input type="hidden" name="lista" value={data.lista} />
					<label for="valor">IP o red</label>
					<input
						id="valor"
						name="valor"
						class="mono"
						required
						placeholder="10.20.0.0/24"
						value={form?.valor ?? ''}
					/>
					<label for="motivo">Motivo</label>
					<input id="motivo" name="motivo" required value={form?.motivo ?? ''} />
					<label for="dias">Caduca en</label>
					<select id="dias" name="dias">
						<option value="0">Nunca</option>
						<option value="1">1 día</option>
						<option value="7" selected={!blanca}>7 días</option>
						<option value="30">30 días</option>
					</select>
					{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
					<button class="boton principal">Añadir</button>
				</form>
			{/if}

			<form class="panel bloque" method="POST" action="?/comparticion" use:enhance>
				<h2>Compartir con otros clientes</h2>
				<label class="interruptor">
					<input type="checkbox" name="compartir" checked={data.comparticion.compartir} />
					<span>
						<b>Compartir mis indicadores</b>
						<small
							>Solo IPs públicas con sesión completa. Nunca IPs internas, usuarios ni tu nombre.</small
						>
					</span>
				</label>
				<label class="interruptor">
					<input type="checkbox" name="recibir" checked={data.comparticion.recibir} />
					<span>
						<b>Recibir la lista global</b>
						<small>Indicadores vistos por varios clientes o aprobados por SeguridadSI.</small>
					</span>
				</label>
				{#if form?.guardado}<p class="guardado" role="status">Guardado.</p>{/if}
				{#if puede(roles, 'ajustes')}<button class="boton">Guardar</button>{/if}
			</form>
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

	@media (max-width: 960px) {
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
