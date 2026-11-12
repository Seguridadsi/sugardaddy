<script lang="ts">
	import CopiarTexto from '$lib/components/CopiarTexto.svelte';
	import Pestanas from '$lib/components/Pestanas.svelte';
	import { pestanaDe } from '$lib/pestanas';
	import { enhance } from '$app/forms';
	import { sinVaciar } from '$lib/guardar';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { nombreTipoDestino } from '$lib/destinos';
	import { ENTORNOS, ENTORNO_ETIQUETA } from '$lib/entorno';
	import { haceCuanto } from '$lib/formato';
	import { puede } from '$lib/permisos';
	import { redYVlan } from '$lib/red';

	let { data, form } = $props();
	const admin = $derived(puede(page.data.usuario?.roles ?? [], 'ajustes'));
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));
	/* Lo que hay por un lado y dar de alta por otro: nunca uno debajo del otro. */
	const PESTANAS = $derived([
		{ id: 'sensors', texto: 'Sensors' },
		...(data.community ? [] : [{ id: 'targets', texto: 'Targets without a sensor' }]),
		...(data.cuarentena.length ? [{ id: 'quarantine', texto: 'Quarantine' }] : []),
		...(admin ? [{ id: 'install', texto: 'Install a remote sensor' }] : [])
	]);
	const pestana = $derived(pestanaDe(page.url, PESTANAS) as string);
	/* El sensor cuya red no se pudo guardar: su formulario sigue abierto. */
	const cambiando = $derived(form && 'cambiando' in form ? form.cambiando : null);
	/* Los avisos de todos los sensores, primero los que dejan a un sensor sin trampas. */
	const avisos = $derived(
		data.sensores
			.flatMap((x) => x.avisos.map((a) => ({ ...a, sensor: x.id, nombre: x.nombre })))
			.sort((a, b) => Number(b.gravedad === 'error') - Number(a.gravedad === 'error'))
	);
</script>

<svelte:head>
	<title>Sensors — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Sensors</h1>
</div>

{#if data.baja}<p class="mensaje" role="status">Target removed.</p>{/if}

{#if form?.linea}
	<section class="panel token" role="status">
		<h2>Install line for <span class="mono">{form.para}</span></h2>
		<p>
			Paste it on the Ubuntu machine where the sensor will run (another VLAN, another site, the
			cloud). It works once, for 24 hours, and is only shown now: copy it before you leave or reload
			this page. That machine must be able to reach this console on port 443 and resolve its name{#if form.consola},
				<span class="mono">{form.consola}</span>
				(DNS or
				<span class="mono">/etc/hosts</span>){/if}.
		</p>
		<p class="mono valor">{form.linea}</p>
		<p><CopiarTexto texto={form.linea} etiqueta="Copy the line" /></p>
	</section>
{/if}
{#if form?.mensaje}<p class="mensaje" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Sensor sections" />

{#if avisos.length && pestana === 'sensors'}
	<!-- Lo que el sensor cuenta de su máquina (desde la 0.13.1), con su código para soporte. -->
	<section class="panel avisos" aria-label="Sensor warnings">
		<ul>
			{#each avisos as a (`${a.sensor}/${a.codigo}`)}
				<li class:grave={a.gravedad === 'error'}>
					<p>
						<b>{a.nombre}: {a.titulo}</b>
						<small class="mono" title="Support code">{a.codigo}</small>
					</p>
					<p>{a.texto}</p>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if pestana === 'sensors'}
	<section class="panel">
		<table>
			<thead>
				<tr>
					<th>Sensor</th>
					<th>IP · network / VLAN</th>
					<th class="num">Honeypots</th>
					<th>Status</th>
					{#if admin}<th></th>{/if}
				</tr>
			</thead>
			<tbody>
				{#each data.sensores as x (x.id)}
					<tr>
						<td>
							{#if data.fichas[x.id]}
								<a class="nombre" href={resolve('/targets/[id]', { id: data.fichas[x.id] })}
									>{x.nombre}</a
								>
							{:else}
								<b>{x.nombre}</b>
							{/if}
							<small class="mono"
								>{x.id} · {x.remoto
									? `remote${x.version ? ` · v${x.version}` : ''}`
									: 'node'}</small
							>
							{#if x.motor}<small title="Its container engine">{x.motor}</small>{/if}
						</td>
						<td class="red">
							{#if x.ips.length}
								<span class="ips mono" title="The IP addresses of the sensor machine"
									>{x.ips.join(' · ')}</span
								>
							{/if}
							{#if admin}
								<details open={cambiando === x.id}>
									<summary class:sin={!x.red && !x.vlan && !x.redNombre}
										>{[x.redNombre, redYVlan(x.red, x.vlan)].filter(Boolean).join(' · ') ||
											'not set'}</summary
									>
									<form method="POST" action="?/red" use:enhance>
										<input type="hidden" name="id" value={x.id} />
										<input
											name="red"
											class="mono"
											aria-label="Network in CIDR"
											placeholder="10.70.0.0/24"
											value={x.red ?? ''}
										/>
										<input
											name="vlan"
											class="mono"
											aria-label="VLAN"
											placeholder="VLAN"
											inputmode="numeric"
											value={x.vlan ?? ''}
										/>
										<input
											name="redNombre"
											aria-label="Network name"
											placeholder="Network name"
											maxlength="60"
											value={x.redNombre ?? ''}
										/>
										<button class="boton">Save</button>
									</form>
								</details>
							{:else}
								<span class="mono" class:sin={!x.red && !x.vlan && !x.redNombre}
									>{[x.redNombre, redYVlan(x.red, x.vlan)].filter(Boolean).join(' · ') ||
										'not set'}</span
								>
							{/if}
							<div class="entorno">
								{#if admin}
									<form method="POST" action="?/entorno" use:enhance>
										<input type="hidden" name="id" value={x.id} />
										<select
											name="entorno"
											aria-label="Sensor environment"
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
										>
											<option value="" selected={!x.entorno}>no environment</option>
											{#each ENTORNOS as ent (ent)}
												<option value={ent} selected={x.entorno === ent}
													>{ENTORNO_ETIQUETA[ent]}</option
												>
											{/each}
										</select>
									</form>
								{:else}
									<small class:sin={!x.entorno}
										>{x.entorno ? ENTORNO_ETIQUETA[x.entorno] : 'no environment'}</small
									>
								{/if}
							</div>
							<div class="propio">
								{#if admin}
									<form method="POST" action="?/registrarPropio" use:enhance={sinVaciar}>
										<input type="hidden" name="id" value={x.id} />
										<label>
											<input
												type="checkbox"
												name="registrar"
												value="si"
												checked={x.registrarPropio}
												onchange={(e) => e.currentTarget.form?.requestSubmit()}
											/>
											Record connections from this sensor's own machine
										</label>
									</form>
								{:else}
									<small
										>{x.registrarPropio
											? 'Records connections from its own machine'
											: "Doesn't record connections from its own machine"}</small
									>
								{/if}
							</div>
						</td>
						<td class="num mono">{x.trampas}</td>
						<td>
							<span class="estado" class:mal={!x.vivo}>
								{x.vivo
									? 'online'
									: x.ultimoLatido
										? `offline ${haceCuanto(x.ultimoLatido, data.ahora)}`
										: 'never connected'}
							</span>
							{#if data.silencios[x.id]?.length}
								<small class="aviso" title="Set on the Alerts tab of this sensor"
									>Alerts muted: {data.silencios[x.id].join(', ')}</small
								>
							{/if}
							{#each x.avisos as a (a.codigo)}
								<small class="aviso" class:grave={a.gravedad === 'error'}>{a.titulo}</small>
							{/each}
							{#if x.configuracion?.estado === 'fallida'}
								<small class="aviso" title={x.configuracion.detalle ?? ''}
									>the configuration for version {x.configuracion.version} did not come up healthy</small
								>
							{:else if x.configuracion?.estado === 'aplicando'}
								<small>applying the configuration for version {x.configuracion.version}</small>
							{/if}
							{#if x.registroPrivado === false && x.vivo}
								<small
									class="aviso"
									title={`It will catch up with its next version${x.remoto ? ' or when reinstalled with a new line' : ''}. Until then, honeypots whose image is in the private registry are not sent to it and show as "On hold" in Honeypots.`}
									>no registry credential: its honeypots wait for it to update</small
								>
							{/if}
							{#if x.cuarentena || x.rupturas}
								<small class="aviso">
									{#if x.cuarentena}{x.cuarentena} quarantined{/if}{#if x.cuarentena && x.rupturas}
										·
									{/if}{#if x.rupturas}chain broken {x.rupturas}
										{x.rupturas === 1 ? 'time' : 'times'}{/if}
								</small>
							{/if}
						</td>
						{#if admin}
							<td class="acciones">
								{#if x.remoto}
									<form method="POST" action="?/linea" use:enhance>
										<input type="hidden" name="id" value={x.id} />
										{#if data.acceso.estado === 'restringida'}
											<input
												name="ip"
												class="mono ip-maquina"
												placeholder="Machine IP"
												aria-label="IP address of the sensor machine"
												title="Only if it is a different machine: its address joins the console access list"
											/>
										{/if}
										<button class="boton" title="To reinstall it, or if the previous one was lost"
											>New line</button
										>
									</form>
								{/if}
								<form method="POST" action="?/retirar" use:enhance>
									<input type="hidden" name="id" value={x.id} />
									<button
										class="boton peligro"
										disabled={x.trampas > 0}
										title={x.trampas > 0 ? 'Remove its honeypots first' : ''}>Remove</button
									>
								</form>
							</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="nota-propio">
			When "Record connections from this sensor's own machine" is off, connections from the sensor's
			own network address are neither recorded nor alerted on, and its honeypots stop listening on
			<code>localhost</code>. Tests started from the console are still recorded, and so is anything
			aimed at a honeypot that a bait points to. With Docker Desktop, WSL or rootless Docker,
			everything is recorded. Changing it restarts the sensor's honeypots. Turn it on if a forwarder
			on that machine (nginx, an SSH tunnel) points at a honeypot: its clients look like the machine
			itself. Bear in mind that anyone already inside that machine can reach its honeypots through
			its network address without leaving a record.
		</p>
	</section>
{/if}

{#if !data.community && pestana === 'targets'}
	<section class="panel destinos">
		<header>
			<div>
				<h2>Targets without a sensor</h2>
				<p class="ayuda">
					A server, a NAS or a cloud account where you deploy honeypots by hand. Machines with a
					sensor are listed above: their name links to their page.
				</p>
			</div>
			{#if opera}<a class="boton" href={resolve('/targets/new')}>Add target</a>{/if}
		</header>
		{#if data.sinSensor.length}
			<ul>
				{#each data.sinSensor as d (d.id)}
					<li>
						<div>
							<a class="nombre" href={resolve('/targets/[id]', { id: d.id })}>{d.nombre}</a>
							<span class="tag">{nombreTipoDestino(d.tipo)}</span>
							{#if !d.activo}<span class="tag">removed</span>{/if}
							<small>{d.plataforma ?? 'No system data'}</small>
						</div>
						<span class="mono">{d.trampas} {d.trampas === 1 ? 'honeypot' : 'honeypots'}</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="vacio">There are none yet.</p>
		{/if}
	</section>
{/if}

{#if data.cuarentena.length && pestana === 'quarantine'}
	<section class="panel cuarentena">
		<h2>Quarantine</h2>
		<p class="ayuda">
			What a sensor delivered that could not be saved as an event. It does not stop delivery: it is
			set aside with its reason and delivery continues.
		</p>
		<ul>
			{#each data.cuarentena as q (q.id)}
				<li>
					<span class="mono cuando">{haceCuanto(q.recibido, data.ahora)}</span>
					<span class="mono">{q.sensor}</span>
					<span>{q.motivo}</span>
					<details>
						<summary>view line</summary>
						<pre class="mono">{q.linea}</pre>
					</details>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if admin && pestana === 'install'}
	<form class="panel alta" id="install" method="POST" action="?/crear&tab=install" use:enhance>
		<h2>Install a remote sensor</h2>
		<p class="ayuda">
			On another VLAN, another site or the cloud. When you enroll it, you get a line to paste on
			that machine, a Linux amd64 (on Ubuntu and Debian it installs Docker if missing): the console
			does not log in to it or ask for its credentials. It only needs outbound access to port 443 on
			this console. Its network and VLAN are detected during installation. Type the identifier
			however you like: it is stored in lowercase with hyphens; if left empty, it is derived from
			the name.
		</p>
		<div class="campos">
			<div>
				<label for="id">Identifier</label>
				<input id="id" name="id" class="mono" placeholder="seville-plant" value={form?.id ?? ''} />
			</div>
			<div>
				<label for="nombre">Name</label>
				<input
					id="nombre"
					name="nombre"
					required
					placeholder="Seville plant"
					value={form?.nombre ?? ''}
				/>
			</div>
			<div>
				<label for="entorno">Where it is</label>
				<select id="entorno" name="entorno">
					<option value="" selected={!form || !('entorno' in form) || !form.entorno}
						>Choose later</option
					>
					{#each ENTORNOS as e (e)}
						<option value={e} selected={form && 'entorno' in form && form.entorno === e}
							>{ENTORNO_ETIQUETA[e]}</option
						>
					{/each}
				</select>
			</div>
			<div>
				<label for="ip">IP address of the sensor machine</label>
				<input
					id="ip"
					name="ip"
					class="mono"
					placeholder="10.70.0.15"
					required={data.acceso.estado === 'restringida'}
					value={form?.ip ?? ''}
				/>
			</div>
		</div>
		<p class="ayuda">
			Where it is decides how its honeypots are named and scored. Choose External for a machine
			exposed to the internet: its honeypots will not carry names taken from your internal domain.
		</p>
		<p class="ayuda">
			{#if data.acceso.estado === 'restringida'}
				Required: access to this console is limited, and this address joins the list so the sensor
				can connect.
			{:else}
				Optional: if you later limit who can open the console, this address is already in the list.
			{/if}
		</p>
		<button class="boton principal">Enroll and generate the line</button>
	</form>
{/if}

<style>
	.ip-maquina {
		width: 9rem;
	}
	.cabecera {
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.token,
	.alta {
		padding: 16px 18px 18px;
		margin: 0 0 16px;
	}

	.token {
		border-color: var(--accent);
	}

	.token h2,
	.alta h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.token p {
		font-size: 13px;
		color: var(--ink-2);
		margin: 6px 0;
	}

	.alta .ayuda,
	.cuarentena .ayuda {
		margin: 4px 0 12px;
		font-size: 13px;
		color: var(--ink-3);
	}

	.valor {
		padding: 10px 12px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		color: var(--ink) !important;
		word-break: break-all;
		user-select: all;
	}

	.mensaje,
	.error {
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
	}

	.mensaje {
		background: var(--accent-soft);
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}

	.panel:has(table) {
		overflow-x: auto;
		margin-bottom: 16px;
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

	td small {
		display: block;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.num {
		text-align: right;
	}

	.ips {
		display: block;
		margin-bottom: 2px;
		font-weight: 600;
	}

	.red summary {
		cursor: pointer;
		font-family: var(--font-mono);
		width: max-content;
	}

	.sin {
		color: var(--ink-3);
		font-family: inherit;
	}

	.red form {
		display: flex;
		gap: 6px;
		margin-top: 6px;
	}

	.red input:not([type='checkbox']) {
		width: 130px;
	}

	.red input[name='vlan'] {
		width: 70px;
	}

	.estado {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ok);
	}

	.estado.mal {
		color: var(--crit);
	}

	.acciones {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	.boton:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.campos {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	@media (max-width: 1008px) {
		.campos {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.alta .boton {
		margin-top: 14px;
	}

	.aviso {
		display: block;
		margin-top: 3px;
		font-size: 11.5px;
		color: var(--warn);
	}

	.aviso.grave {
		color: var(--crit);
	}

	.avisos {
		padding: 4px 18px;
		margin: 0 0 16px;
		border-color: var(--warn);
	}

	.avisos:has(.grave) {
		border-color: var(--crit);
	}

	.avisos ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.avisos li {
		padding: 10px 0 10px 12px;
		border-bottom: 1px solid var(--line);
		box-shadow: inset 3px 0 0 var(--warn);
		font-size: 13px;
	}

	.avisos li:last-child {
		border-bottom: none;
	}

	.avisos li.grave {
		box-shadow: inset 3px 0 0 var(--crit);
	}

	.avisos p {
		margin: 0;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.avisos p:first-child {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		margin-bottom: 3px;
		color: var(--ink);
	}

	.avisos small {
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.cuarentena {
		padding: 16px 18px;
		margin-top: 16px;
	}

	.nombre {
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.nombre:hover {
		color: var(--accent);
	}

	.destinos {
		padding: 16px 18px 6px;
		margin: 0 0 16px;
	}

	.destinos header {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px 16px;
	}

	.destinos h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.destinos .ayuda {
		margin: 4px 0 8px;
		font-size: 13px;
		color: var(--ink-3);
	}

	.destinos ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.destinos li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--line);
		font-size: 13.5px;
	}

	.destinos li div {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		min-width: 0;
	}

	.destinos li small {
		flex-basis: 100%;
		font-size: 12px;
		color: var(--ink-3);
	}

	.destinos .vacio {
		padding: 10px 0 12px;
		margin: 0;
		font-size: 13px;
		color: var(--ink-3);
	}

	.cuarentena h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}

	.cuarentena ul {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
	}

	.cuarentena li {
		display: grid;
		grid-template-columns: 90px 160px minmax(0, 1fr);
		gap: 4px 12px;
		padding: 7px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}

	.cuarentena .cuando {
		color: var(--ink-3);
		font-size: 12px;
	}

	.cuarentena details {
		grid-column: 1 / -1;
		font-size: 12px;
	}

	.cuarentena summary {
		cursor: pointer;
		color: var(--ink-3);
		width: max-content;
	}

	.cuarentena pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 200px;
		overflow-y: auto;
		margin: 6px 0 0;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--sunk, var(--surface));
	}

	@media (max-width: 1008px) {
		.cuarentena li {
			grid-template-columns: 1fr;
		}
	}

	.propio {
		margin-top: 6px;
	}

	.propio form {
		margin: 0;
	}

	.propio label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 400;
		color: var(--ink-2);
	}

	.propio small {
		color: var(--ink-3);
	}

	.nota-propio {
		margin: 10px 14px 12px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--ink-2);
	}

	/*
	 * En una ventana estrecha la tabla no cabe y la última columna (la IP de la
	 * máquina, «New line», «Remove») quedaba fuera de la vista: cada sensor pasa a
	 * ser un bloque, con todo a la vista.
	 */
	@media (max-width: 1100px) {
		thead {
			display: none;
		}
		table,
		tbody,
		tr,
		td {
			display: block;
			width: auto;
		}
		tr {
			border-bottom: 1px solid var(--line);
			padding: 6px 0;
		}
		tr:last-child {
			border-bottom: none;
		}
		td {
			border-bottom: none;
			padding: 6px 16px;
		}
		td.num {
			text-align: left;
		}
		td.num::before {
			content: 'Honeypots: ';
			color: var(--ink-3);
		}
		td.acciones {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: center;
		}
	}
</style>
