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

<aside class="detalle" aria-label="Detalle">
	<button class="cerrar" aria-label="Cerrar el detalle" onclick={oncerrar}>×</button>

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

		<h3>Dónde está</h3>
		<dl>
			<dt>Sitio</dt>
			<dd>{detalle.equipo}</dd>
			{#if t.conIpPropia}
				<dt>IP propia</dt>
				<dd class="mono">{t.ipPropia ?? 'Sin asignar todavía'}</dd>
			{:else if detalle.ip}
				<dt>IP del sitio</dt>
				<dd class="mono">{detalle.ip}</dd>
			{/if}
			{#if t.ubicacion}
				<dt>Ubicación</dt>
				<dd class="mono">{t.ubicacion}</dd>
			{/if}
		</dl>

		{#if t.puertos.length}
			<h3>Servicios y puertos</h3>
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
			<h3>Relaciones</h3>
			{#if t.ruta}
				<p>
					{t.ruta.texto}
					{#if t.ruta.destino}<b class="mono">{t.ruta.destino}</b>{/if}
				</p>
			{/if}
			{#if t.recibeDe.length}<p>Recibe la señal de <b>{enumerar(t.recibeDe, 8)}</b></p>{/if}
		{/if}

		<h3>Actividad</h3>
		<p><b>{t.eventos}</b> {t.eventos === 1 ? 'evento' : 'eventos'} en las últimas 24 horas</p>
		<div class="acciones">
			<a class="boton" href={resolve('/trampas/[id]', { id: t.id })}>Abrir la ficha</a>
			{#if t.eventos > 0}
				<a class="boton" href="{resolve('/eventos')}?trampa={encodeURIComponent(t.id)}"
					>Ver eventos</a
				>
			{/if}
		</div>
	{:else if detalle.tipo === 'familia'}
		<header>
			<LogoTrampa pictograma={detalle.familia} grande />
			<div>
				<h2>{detalle.nombre}</h2>
				<p class="sub">{detalle.trampas.length} trampas de este tipo</p>
			</div>
		</header>
		{@render listaTrampas(detalle.trampas)}
	{:else if detalle.tipo === 'sensor'}
		{@const x = detalle.sensor}
		<header>
			<div>
				<span class="chip sensor">SENSOR</span>
				<h2>{x.nombre}</h2>
				<p class="sub">{x.local ? 'Local, en la máquina de la consola' : 'Remoto'}</p>
			</div>
		</header>
		<p class="ip-grande">{x.ip ?? 'IP sin informar'}</p>
		<p class="estado" class:bien={x.vivo} class:mal={!x.vivo}>
			{x.vivo ? 'En línea' : x.ultimoLatido ? 'Sin contacto' : 'Nunca ha contactado'}{x.ultimoLatido
				? ` · ${haceCuanto(x.ultimoLatido, ahora)}`
				: ''}
		</p>
		{#each x.avisos as a (a)}<p class="aviso">{a}</p>{/each}
		<dl>
			{#if x.otrasIps.length}
				<dt>Otras IP</dt>
				<dd class="mono">{x.otrasIps.join(', ')}</dd>
			{/if}
			{#if detalle.zona.red}
				<dt>Red</dt>
				<dd class="mono">
					{detalle.zona.red}{detalle.zona.vlan ? ` · VLAN ${detalle.zona.vlan}` : ''}
				</dd>
			{/if}
			{#if x.entorno}
				<dt>Entorno</dt>
				<dd>{x.entorno}</dd>
			{/if}
			{#if x.plataforma}
				<dt>Sistema</dt>
				<dd>{x.plataforma}</dd>
			{/if}
			{#if x.motor}
				<dt>Motor</dt>
				<dd>{x.motor}</dd>
			{/if}
			{#if x.version}
				<dt>Versión</dt>
				<dd class="mono">{x.version}</dd>
			{/if}
			<dt>Trampas</dt>
			<dd>
				{x.trampas.length} aquí, {x.sistemas.length}
				{x.sistemas.length === 1 ? 'sitio enlazado' : 'sitios enlazados'}
			</dd>
		</dl>
		<div class="acciones">
			{#if x.ficha}
				<a class="boton" href={resolve('/destinos/[id]', { id: x.ficha })}>Abrir la ficha</a>
			{/if}
			<a class="boton" href={resolve('/sensores')}>Ver en Sensores</a>
		</div>
	{:else if detalle.tipo === 'sistema'}
		{@const y = detalle.sistema}
		<header>
			<div>
				<span class="chip sin">{y.tipo}</span>
				<h2>{y.nombre}</h2>
				<p class="sub">Sitio sin sensor</p>
			</div>
		</header>
		{#if y.direccion}
			<p class="ip-grande">{y.direccion}</p>
		{:else if y.faltaDireccion}
			<p class="aviso">IP sin indicar: añádela en su ficha.</p>
		{/if}
		<dl>
			{#if y.plataforma}
				<dt>Sistema</dt>
				<dd>{y.plataforma}</dd>
			{/if}
			{#if detalle.recibe}
				<dt>Recibe su señal</dt>
				<dd>{detalle.recibe.nombre}</dd>
			{/if}
		</dl>
		{#if y.ruta}
			<h3>Cómo llega la señal</h3>
			<p>
				{y.ruta.texto}
				{#if y.ruta.destino}<b class="mono">{y.ruta.destino}</b>{/if}
			</p>
		{/if}
		{#if y.trampas.length}
			<h3>Trampas aquí</h3>
			{@render listaTrampas(y.trampas)}
		{/if}
		<div class="acciones">
			<a class="boton" href={resolve('/destinos/[id]', { id: y.id })}>Abrir la ficha</a>
		</div>
	{:else}
		<header>
			<div>
				<span class="chip rele">{detalle.zona.rele ? 'RELÉ' : 'INTERNET'}</span>
				<h2>{detalle.zona.rele ? 'Relé público y panel central' : 'Fuera de tu red'}</h2>
			</div>
		</header>
		<p>
			{detalle.zona.rele
				? 'Recoge lo que ocurre fuera de tu red; la consola lo recibe en su latido, sin abrir nada hacia dentro.'
				: 'Lo que ocurre fuera llega a la dirección pública de la consola o se consulta con los conectores de nube.'}
		</p>
		<p>
			{detalle.zona.sistemas.length}
			{detalle.zona.sistemas.length === 1 ? 'sistema' : 'sistemas'} fuera de tu red.
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
