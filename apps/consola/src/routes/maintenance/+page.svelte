<!--
	Ventanas de mantenimiento (lib/server/mantenimiento.ts): la lista, programar
	una (o empezarla ya) y el ajuste del administrador, cada cosa en su pestaña.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Pestanas from '$lib/components/Pestanas.svelte';
	import { pestanaDe } from '$lib/pestanas';
	import { semanaHora as cuando } from '$lib/fechas-pantalla';

	let { data, form } = $props();

	const PESTANAS = $derived([
		{ id: 'windows', texto: 'Windows' },
		...(data.puedeProgramar ? [{ id: 'schedule', texto: 'Schedule' }] : []),
		...(data.puedeAjustar ? [{ id: 'settings', texto: 'Settings' }] : [])
	]);
	const pestana = $derived(pestanaDe(page.url, PESTANAS) as string);

	let alcance = $state<'sitios' | 'sensores' | 'nodo'>('sensores');
	const numero = (n: number) => n.toLocaleString('en-GB');
	const ESTADO: Record<string, string> = {
		programada: 'scheduled',
		'en-curso': 'in progress',
		terminada: 'ended'
	};
	const horas = (h: number) =>
		h % 24 === 0 ? `${h / 24} ${h === 24 ? 'day' : 'days'}` : `${h} ${h === 1 ? 'hour' : 'hours'}`;
</script>

<svelte:head>
	<title>Maintenance windows — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Maintenance windows</h1>
	<p class="desc">
		For planned stops such as patching or reboots. During a window, the <b>health alerts</b> of what
		it covers (sensor not responding, sensor silent, honeypot down or stopped) are held back.
		<b>Events are still stored, and attacks still alert</b>: a honeypot touched during maintenance
		is exactly what you want to hear about. Windows end on their own, and a summary of what happened
		arrives when they do.
	</p>
</div>

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Maintenance sections" />

{#if form?.mensaje}<p class="ok" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="mal" role="alert">{form.error}</p>{/if}

{#if pestana === 'windows'}
	<section class="panel bloque">
		{#if data.ventanas.length}
			<ul class="ventanas">
				{#each data.ventanas as v (v.id)}
					<li class:marcha={v.estado === 'en-curso'}>
						<div class="que">
							<b>{v.nombre}</b>
							<span class="estado-p">{ESTADO[v.estado]}</span>
							<small>
								{cuando(v.desde)} → {cuando(v.hasta)} · {v.alcance} · by {v.quien}{v.cerradaPor
									? ` · ended early by ${v.cerradaPor}`
									: ''}{v.estado !== 'programada'
									? ` · ${numero(v.callados)} health ${v.callados === 1 ? 'alert' : 'alerts'} held back`
									: ''}{v.eventos !== null ? ` · ${numero(v.eventos)} events` : ''}
							</small>
							{#if v.nota}<small>{v.nota}</small>{/if}
						</div>
						{#if v.estado !== 'programada'}
							<a href="/maintenance/{v.id}">{v.estado === 'terminada' ? 'Summary' : 'View'}</a>
						{/if}
						{#if data.puedeProgramar && v.estado !== 'terminada'}
							<form method="POST" action="?/terminar" use:enhance>
								<input type="hidden" name="id" value={v.id} />
								<button class="boton">{v.estado === 'programada' ? 'Cancel' : 'End now'}</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="vacio">
				No maintenance windows yet.{#if data.puedeProgramar}
					<a href="?tab=schedule">Schedule one</a>.{/if}
			</p>
		{/if}
	</section>
{/if}

{#if pestana === 'schedule' && data.puedeProgramar}
	<form class="panel bloque" method="POST" action="?/crear" use:enhance>
		<p class="ayuda">
			Leave "Starts" empty to start it now. It can last up to {horas(data.maximo)}; an administrator
			can change that limit in Settings.
			{#if data.community}
				Its summary is here when it ends.
			{:else}
				You are alerted when it starts, through your outputs set to "Node health", and when it ends,
				with a summary.
			{/if}
		</p>
		<div class="campos">
			<label>
				<span>Name</span>
				<input name="nombre" required maxlength="80" placeholder="Monthly patching" />
			</label>
			<label>
				<span>Starts (empty: now)</span>
				<input name="empieza" type="datetime-local" />
			</label>
			<label>
				<span>Duration</span>
				<select name="dura">
					{#each data.duraciones as h (h)}
						<option value={h} selected={h === Math.min(4, data.maximo)}>{horas(h)}</option>
					{/each}
				</select>
			</label>
			<label class="ancha">
				<span>Note (optional)</span>
				<input name="nota" maxlength="500" placeholder="Windows updates on the file servers" />
			</label>
		</div>

		<fieldset class="alcance">
			<legend>What it covers</legend>
			<label class="casilla">
				<input type="radio" name="alcance" value="sensores" bind:group={alcance} />
				Some sensors (and their honeypots)
			</label>
			<label class="casilla">
				<input type="radio" name="alcance" value="sitios" bind:group={alcance} />
				Some sites (their sensor, if any, and the honeypots placed there)
			</label>
			{#if data.puedeNodo}
				<label class="casilla">
					<input type="radio" name="alcance" value="nodo" bind:group={alcance} />
					The whole node
				</label>
			{/if}
		</fieldset>

		{#if alcance === 'sensores'}
			{#if data.sensores.length}
				<div class="lista">
					{#each data.sensores as x (x.id)}
						<label class="casilla"
							><input type="checkbox" name="sensor" value={x.id} /> {x.nombre}</label
						>
					{/each}
				</div>
			{:else}
				<p class="vacio">There are no sensors yet.</p>
			{/if}
		{:else if alcance === 'sitios'}
			{#if data.sitios.length}
				<div class="lista">
					{#each data.sitios as x (x.id)}
						<label class="casilla"
							><input type="checkbox" name="sitio" value={x.id} /> {x.nombre}</label
						>
					{/each}
				</div>
			{:else}
				<p class="vacio">There are no sites yet.</p>
			{/if}
		{:else}
			<p class="ayuda">
				Every health alert of this node is held back while it lasts. If the console itself goes down
				meanwhile, the central panel does not report this node as offline until the window ends.
			</p>
		{/if}

		<button class="boton principal">Schedule</button>
	</form>
{/if}

{#if pestana === 'settings' && data.puedeAjustar}
	<form class="panel bloque" method="POST" action="?/ajustes" use:enhance>
		<p class="ayuda">
			The longest a maintenance window can last. A long window keeps health alerts quiet for that
			long: keep it as short as your maintenance needs. Up to {data.tope} hours.
		</p>
		<div class="campos">
			<label>
				<span>Maximum duration (hours)</span>
				<input name="maximo" type="number" min="1" max={data.tope} value={data.maximo} required />
			</label>
		</div>
		<button class="boton principal">Save</button>
	</form>
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

	.desc {
		color: var(--ink-2);
		max-width: 85ch;
		margin: 6px 0 0;
	}

	.bloque {
		padding: 16px 18px 18px;
		margin-bottom: 18px;
	}

	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 0 0 10px;
		max-width: 80ch;
	}

	.campos {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 10px 14px;
		margin: 10px 0;
	}

	.campos label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 13px;
		color: var(--ink-2);
	}

	.campos .ancha {
		grid-column: 1 / -1;
	}

	input:not([type='checkbox']):not([type='radio']),
	select {
		padding: 7px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		color: var(--ink);
		min-width: 0;
	}

	.alcance {
		border: 0;
		margin: 6px 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 18px;
	}

	.alcance legend {
		font-size: 13px;
		color: var(--ink-2);
		margin-bottom: 4px;
	}

	.lista {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 2px 14px;
		margin: 4px 0 12px;
	}

	.casilla {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		margin: 4px 0;
	}

	.ventanas {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.ventanas li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 14px;
		padding: 9px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	.ventanas .que {
		flex: 1 1 320px;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
	}

	.ventanas small {
		flex-basis: 100%;
		color: var(--ink-3);
	}

	.estado-p {
		font-size: 11.5px;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.ventanas li.marcha .estado-p {
		color: var(--warn);
		font-weight: 700;
	}

	.vacio {
		color: var(--ink-3);
		font-size: 13.5px;
		margin: 0;
	}

	.ok {
		color: var(--ok);
		font-size: 13.5px;
	}

	.mal {
		color: var(--crit);
		font-size: 13.5px;
	}
</style>
