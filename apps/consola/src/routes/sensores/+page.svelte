<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { haceCuanto } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const admin = $derived(puede(page.data.usuario?.roles ?? [], 'ajustes'));
	/* Los avisos de todos los sensores, primero los que dejan a un sensor sin trampas. */
	const avisos = $derived(
		data.sensores
			.flatMap((x) => x.avisos.map((a) => ({ ...a, sensor: x.id, nombre: x.nombre })))
			.sort((a, b) => Number(b.gravedad === 'error') - Number(a.gravedad === 'error'))
	);
</script>

<svelte:head>
	<title>Sensores — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Sensores</h1>
</div>

{#if form?.linea}
	<section class="panel token" role="status">
		<h2>Línea de instalación de <span class="mono">{form.para}</span></h2>
		<p>
			Pégala en el Ubuntu donde va el sensor (otra VLAN, otra sede, la nube). Vale una vez y 24
			horas, y solo se muestra ahora. Esa máquina tiene que llegar a esta consola por el 443 y
			resolver su nombre.
		</p>
		<p class="mono valor">{form.linea}</p>
	</section>
{/if}
{#if form?.mensaje}<p class="mensaje" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

{#if avisos.length}
	<!-- Lo que el sensor cuenta de su máquina (desde la 0.13.1), con su código para soporte. -->
	<section class="panel avisos" aria-label="Avisos de los sensores">
		<ul>
			{#each avisos as a (`${a.sensor}/${a.codigo}`)}
				<li class:grave={a.gravedad === 'error'}>
					<p>
						<b>{a.nombre}: {a.titulo}</b>
						<small class="mono" title="Código para soporte">{a.codigo}</small>
					</p>
					<p>{a.texto}</p>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="panel">
	<table>
		<thead>
			<tr>
				<th>Sensor</th>
				<th>Segmento</th>
				<th class="num">Trampas</th>
				<th>Estado</th>
				{#if admin}<th></th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each data.sensores as x (x.id)}
				<tr>
					<td>
						<b>{x.nombre}</b><small class="mono"
							>{x.id} · {x.remoto
								? `remoto${x.version ? ` · v${x.version}` : ''}`
								: 'en el nodo'}</small
						>
						{#if x.motor}<small title="Su motor de contenedores">{x.motor}</small>{/if}
					</td>
					<td class="mono">{x.segmento}</td>
					<td class="num mono">{x.trampas}</td>
					<td>
						<span class="estado" class:mal={!x.vivo}>
							{x.vivo
								? 'en línea'
								: x.ultimoLatido
									? `sin contacto ${haceCuanto(x.ultimoLatido, data.ahora)}`
									: 'nunca ha contactado'}
						</span>
						{#each x.avisos as a (a.codigo)}
							<small class="aviso" class:grave={a.gravedad === 'error'}>{a.titulo}</small>
						{/each}
						{#if x.configuracion?.estado === 'fallida'}
							<small class="aviso" title={x.configuracion.detalle ?? ''}
								>la configuración de la {x.configuracion.version} no quedó sana</small
							>
						{:else if x.configuracion?.estado === 'aplicando'}
							<small>aplicando la configuración de la {x.configuracion.version}</small>
						{/if}
						{#if x.registroPrivado === false && x.vivo}
							<small
								class="aviso"
								title={`Se pondrá al día con su próxima versión${x.remoto ? ' o al reinstalarlo con una línea nueva' : ''}. Mientras, las trampas cuya imagen está en el registro privado no se le mandan y salen «En espera» en Trampas.`}
								>sin credencial del registro: sus trampas esperan a que se ponga al día</small
							>
						{/if}
						{#if x.cuarentena || x.rupturas}
							<small class="aviso">
								{#if x.cuarentena}{x.cuarentena} en cuarentena{/if}{#if x.cuarentena && x.rupturas}
									·
								{/if}{#if x.rupturas}cadena rota {x.rupturas}
									{x.rupturas === 1 ? 'vez' : 'veces'}{/if}
							</small>
						{/if}
					</td>
					{#if admin}
						<td class="acciones">
							{#if x.remoto}
								<form method="POST" action="?/linea" use:enhance>
									<input type="hidden" name="id" value={x.id} />
									<button class="boton" title="Para reinstalarlo, o si la anterior se perdió"
										>Nueva línea</button
									>
								</form>
							{/if}
							<form method="POST" action="?/retirar" use:enhance>
								<input type="hidden" name="id" value={x.id} />
								<button
									class="boton peligro"
									disabled={x.trampas > 0}
									title={x.trampas > 0 ? 'Retira antes sus trampas' : ''}>Retirar</button
								>
							</form>
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</section>

{#if data.cuarentena.length}
	<section class="panel cuarentena">
		<h2>Cuarentena</h2>
		<p class="ayuda">
			Lo que un sensor entregó y no pudo guardarse como evento. No para la entrega: se aparta con su
			motivo y se sigue recibiendo.
		</p>
		<ul>
			{#each data.cuarentena as q (q.id)}
				<li>
					<span class="mono cuando">{haceCuanto(q.recibido, data.ahora)}</span>
					<span class="mono">{q.sensor}</span>
					<span>{q.motivo}</span>
					<details>
						<summary>ver línea</summary>
						<pre class="mono">{q.linea}</pre>
					</details>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if admin}
	<form class="panel alta" method="POST" action="?/crear" use:enhance>
		<h2>Instalar un sensor en otra máquina</h2>
		<p class="ayuda">
			En otra VLAN, otra sede o la nube: un Ubuntu con salida al 443 de esta consola. Al darlo de
			alta te damos la línea que lo instala.
		</p>
		<div class="campos">
			<div>
				<label for="id">Identificador</label>
				<input
					id="id"
					name="id"
					class="mono"
					required
					placeholder="planta-sevilla"
					value={form?.id ?? ''}
				/>
			</div>
			<div>
				<label for="nombre">Nombre</label>
				<input
					id="nombre"
					name="nombre"
					required
					placeholder="Planta de Sevilla"
					value={form?.nombre ?? ''}
				/>
			</div>
			<div>
				<label for="segmento">Segmento</label>
				<input
					id="segmento"
					name="segmento"
					class="mono"
					required
					placeholder="10.70.0.0/24"
					value={form?.segmento ?? ''}
				/>
			</div>
		</div>
		<button class="boton principal">Dar de alta y generar la línea</button>
	</form>
{/if}

<style>
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
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	@media (max-width: 760px) {
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

	@media (max-width: 760px) {
		.cuarentena li {
			grid-template-columns: 1fr;
		}
	}
</style>
