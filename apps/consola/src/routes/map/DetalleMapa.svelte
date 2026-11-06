<!--
	El detalle de lo que se ha pinchado en el grafo: una trampa, su tipo de servicio,
	un sensor, un sistema sin sensor o la salida a internet.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import LogoTrampa from '$lib/components/LogoTrampa.svelte';
	import { haceCuanto } from '$lib/formato';
	import { enumerar, type DetalleNodo, type TrampaMapa } from '$lib/mapa-despliegue';
	import GlifoEstado from './GlifoEstado.svelte';

	type Props = {
		detalle: DetalleNodo;
		ahora: number;
		onelegir: (id: string) => void;
		oncerrar: () => void;
	};
	let { detalle, ahora, onelegir, oncerrar }: Props = $props();
</script>

{#snippet listaTrampas(trampas: TrampaMapa[])}
	<ul class="lista">
		{#each trampas as t (t.id)}
			<li>
				<button onclick={() => onelegir(`t:${t.id}`)}>
					<GlifoEstado estado={t.estado} titulo={t.etiqueta} />
					<span class="nombre">{t.nombre}</span>
					<span class="mono">{t.puertos[0]?.puerto ?? t.ipPropia ?? ''}</span>
				</button>
			</li>
		{/each}
	</ul>
{/snippet}

<aside class="detalle" aria-label="Details">
	<button class="cerrar" aria-label="Close details" onclick={oncerrar}>×</button>

	{#if detalle.tipo === 'trampa'}
		{@const t = detalle.trampa}
		<header>
			<LogoTrampa procedencia={t.procedencia} pictograma={t.pictograma} grande />
			<div>
				<h2>{t.nombre}</h2>
				{#if t.modulo}<p class="sub">{t.modulo}</p>{/if}
			</div>
		</header>
		<p class="estado"><GlifoEstado estado={t.estado} />{t.etiqueta}</p>
		{#if t.motivo}<p class="aviso">{t.motivo}</p>{/if}

		<h3>Where it is</h3>
		<dl>
			<dt>Site</dt>
			<dd>{detalle.equipo}</dd>
			{#if t.conIpPropia}
				<dt>Own IP</dt>
				<dd class="mono">{t.ipPropia ?? 'Not assigned yet'}</dd>
			{:else if detalle.ip}
				<dt>Site IP</dt>
				<dd class="mono">{detalle.ip}</dd>
			{/if}
			{#if t.ubicacion}
				<dt>Location</dt>
				<dd class="mono">{t.ubicacion}</dd>
			{/if}
		</dl>

		{#if t.puertos.length}
			<h3>Services and ports</h3>
			<table>
				<tbody>
					{#each t.puertos as p (p.puerto)}
						<tr>
							<td>{p.servicio}</td>
							<td class="mono"
								>{p.escuchaEn ?? detalle.ip ?? ''}{p.escuchaEn || detalle.ip
									? ':'
									: ''}{p.puerto}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		{#if t.ruta || t.recibeDe.length}
			<h3>Relationships</h3>
			{#if t.ruta}
				<p>
					{t.ruta.texto}
					{#if t.ruta.destino}<b class="mono">{t.ruta.destino}</b>{/if}
				</p>
			{/if}
			{#if t.recibeDe.length}<p>Receives the signal from <b>{enumerar(t.recibeDe, 8)}</b></p>{/if}
		{/if}

		<h3>Activity</h3>
		<p><b>{t.eventos}</b> {t.eventos === 1 ? 'event' : 'events'} in the last 24 hours</p>
		<div class="acciones">
			<a class="boton" href={resolve('/decoys/[id]', { id: t.id })}>Open details</a>
			{#if t.eventos > 0}
				<a class="boton" href="{resolve('/events')}?trampa={encodeURIComponent(t.id)}"
					>View events</a
				>
			{/if}
		</div>
	{:else if detalle.tipo === 'familia'}
		<header>
			<LogoTrampa pictograma={detalle.familia} grande />
			<div>
				<h2>{detalle.nombre}</h2>
				<p class="sub">{detalle.trampas.length} decoys of this type</p>
			</div>
		</header>
		{@render listaTrampas(detalle.trampas)}
	{:else if detalle.tipo === 'sensor'}
		{@const x = detalle.sensor}
		<header>
			<div>
				<span class="chip sensor">SENSOR</span>
				<h2>{x.nombre}</h2>
				<p class="sub">{x.local ? 'Local, on the console machine' : 'Remote'}</p>
			</div>
		</header>
		<p class="ip-grande">{x.ip ?? 'IP not reported'}</p>
		<p class="estado" class:bien={x.vivo} class:mal={!x.vivo}>
			{x.vivo ? 'Online' : x.ultimoLatido ? 'Offline' : 'Never connected'}{x.ultimoLatido
				? ` · ${haceCuanto(x.ultimoLatido, ahora)}`
				: ''}
		</p>
		{#each x.avisos as a (a)}<p class="aviso">{a}</p>{/each}
		<dl>
			{#if x.otrasIps.length}
				<dt>Other IPs</dt>
				<dd class="mono">{x.otrasIps.join(', ')}</dd>
			{/if}
			{#if detalle.zona.red}
				<dt>Network</dt>
				<dd class="mono">
					{detalle.zona.red}{detalle.zona.vlan ? ` · VLAN ${detalle.zona.vlan}` : ''}
				</dd>
			{/if}
			{#if x.entorno}
				<dt>Environment</dt>
				<dd>{x.entorno}</dd>
			{/if}
			{#if x.plataforma}
				<dt>Sistema</dt>
				<dd>{x.plataforma}</dd>
			{/if}
			{#if x.motor}
				<dt>Engine</dt>
				<dd>{x.motor}</dd>
			{/if}
			{#if x.version}
				<dt>Version</dt>
				<dd class="mono">{x.version}</dd>
			{/if}
			<dt>Decoys</dt>
			<dd>
				{x.trampas.length} here, {x.sistemas.length}
				linked {x.sistemas.length === 1 ? 'site' : 'sites'}
			</dd>
		</dl>
		<div class="acciones">
			{#if x.ficha}
				<a class="boton" href={resolve('/targets/[id]', { id: x.ficha })}>Open details</a>
			{/if}
			<a class="boton" href={resolve('/sensors')}>View in Sensors</a>
		</div>
	{:else if detalle.tipo === 'sistema'}
		{@const y = detalle.sistema}
		<header>
			<div>
				<span class="chip sin">{y.tipo}</span>
				<h2>{y.nombre}</h2>
				<p class="sub">Site without a sensor</p>
			</div>
		</header>
		{#if y.direccion}
			<p class="ip-grande">{y.direccion}</p>
		{:else if y.faltaDireccion}
			<p class="aviso">IP not set: add it on its page.</p>
		{/if}
		<dl>
			{#if y.plataforma}
				<dt>Sistema</dt>
				<dd>{y.plataforma}</dd>
			{/if}
			{#if detalle.recibe}
				<dt>Receives its signal</dt>
				<dd>{detalle.recibe.nombre}</dd>
			{/if}
		</dl>
		{#if y.ruta}
			<h3>How the signal arrives</h3>
			<p>
				{y.ruta.texto}
				{#if y.ruta.destino}<b class="mono">{y.ruta.destino}</b>{/if}
			</p>
		{/if}
		{#if y.trampas.length}
			<h3>Decoys here</h3>
			{@render listaTrampas(y.trampas)}
		{/if}
		<div class="acciones">
			<a class="boton" href={resolve('/targets/[id]', { id: y.id })}>Open details</a>
		</div>
	{:else}
		<header>
			<div>
				<span class="chip rele">{detalle.zona.rele ? 'RELAY' : 'INTERNET'}</span>
				<h2>{detalle.zona.rele ? 'Public relay and Central' : 'Outside your network'}</h2>
			</div>
		</header>
		<p>
			{detalle.zona.rele
				? 'Collects what happens outside your network; the console receives it in its heartbeat, without opening anything inward.'
				: "What happens outside reaches the console's public address or is queried through the cloud connectors."}
		</p>
		<p>
			{detalle.zona.sistemas.length}
			{detalle.zona.sistemas.length === 1 ? 'system' : 'systems'} outside your network.
		</p>
	{/if}
</aside>

<style>
	.detalle {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 30;
		width: min(380px, 100vw);
		padding: 20px 20px 28px;
		overflow-y: auto;
		border-left: 1px solid var(--line-strong);
		background: var(--surface);
		box-shadow: var(--shadow-lift);
		font-size: 14px;
	}

	.cerrar {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 30px;
		height: 30px;
		padding: 0;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		font-size: 18px;
		line-height: 1;
		color: var(--ink);
		cursor: pointer;
	}

	header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding-right: 34px;
	}

	h2 {
		margin: 4px 0 0;
		font: 700 18px/1.2 var(--font-display);
		overflow-wrap: anywhere;
	}

	h3 {
		margin: 18px 0 6px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
		font: 600 12px var(--font-body);
		letter-spacing: 0.02em;
		color: var(--ink-3);
	}

	p {
		margin: 6px 0 0;
	}

	p b {
		font-weight: 600;
	}

	.sub {
		margin-top: 2px;
		font-size: 13px;
		color: var(--ink-2);
	}

	.ip-grande {
		margin-top: 12px;
		font: 600 28px/1.15 var(--font-mono);
		overflow-wrap: anywhere;
	}

	.estado {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-top: 12px;
		font-weight: 600;
	}

	.estado.bien {
		color: var(--ok);
	}

	.estado.mal {
		color: var(--crit);
	}

	.aviso {
		font-size: 13px;
		color: var(--warn);
	}

	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 5px 14px;
		margin: 12px 0 0;
	}

	dt {
		font-size: 13px;
		color: var(--ink-2);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	dd.mono {
		font-size: 13px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	td {
		padding: 3px 0;
	}

	td:first-child {
		padding-right: 12px;
		color: var(--ink-2);
	}

	td.mono {
		font-weight: 500;
		text-align: right;
		overflow-wrap: anywhere;
	}

	.lista {
		margin: 12px 0 0;
		padding: 0;
		list-style: none;
	}

	.lista button {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 7px 4px;
		border: 0;
		border-bottom: 1px solid var(--line);
		background: none;
		font: inherit;
		text-align: left;
		color: var(--ink);
		cursor: pointer;
	}

	.lista button:hover {
		background: var(--surface-2);
	}

	.nombre {
		flex: 1;
		min-width: 0;
	}

	.lista .mono {
		font-size: 12.5px;
		color: var(--ink-2);
		white-space: nowrap;
	}

	.acciones {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 18px;
	}

	.chip {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 5px;
		font: 700 11px/1.4 var(--font-display);
		letter-spacing: 0.05em;
	}

	.chip.sensor {
		background: var(--marca);
		color: var(--marca-ink);
	}

	.chip.sin {
		padding: 1px 7px;
		border: 1px solid var(--line-strong);
		color: var(--ink-2);
	}

	.chip.rele {
		background: var(--s-media);
		color: var(--bg);
	}
</style>
