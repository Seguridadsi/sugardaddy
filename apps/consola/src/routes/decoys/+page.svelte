<script lang="ts">
	import Pestanas from '$lib/components/Pestanas.svelte';
	import { pestanaDe } from '$lib/pestanas';
	import { noAccionables, parteDeRuido, porcentaje, ruidoPorMil } from '$lib/ruido';
	import { casa } from '$lib/buscar';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import EstadoTrampa from '$lib/components/EstadoTrampa.svelte';
	import LogoTrampa from '$lib/components/LogoTrampa.svelte';
	import { dondeVisible, estaPuesta, nombreTipo } from '$lib/formato';
	import { alternar, ordenar, type Clave } from '$lib/orden-tabla';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));

	/* El buscador de las trampas ya puestas: por nombre, módulo, tipo, sensor o
	   destino, y dónde escuchan. El catálogo para añadir nuevas va en su página. */
	let buscar = $state('');
	/* Solo las de una plantilla (?template), y dentro de ellas lo que se busque. */
	const deGrupo = $derived(
		data.plantilla
			? data.desplegados.filter((s) => s.plantilla === data.plantilla)
			: data.desplegados
	);
	const grupo = $derived(data.grupos.find((g) => g.id === data.plantilla) ?? null);
	/* Sin resolve: en Community esas páginas no viajan, y la ruta no existe para sus tipos. */
	const plantillas = `${resolve('/decoys')}/templates`;
	const enGrupo = (id: string) => `${resolve('/decoys')}?template=${encodeURIComponent(id)}`;
	type Fila = (typeof data.desplegados)[number];
	/* Lo que enseña la tabla en «Sensor» y en «Location»: con eso se filtra y se ordena. */
	const MANUAL = 'Manual';
	const sensorDe = (s: Fila) => (s.aMano ? MANUAL : s.sensorNombre);
	const dondeDe = (s: Fila) =>
		s.aMano
			? `on ${s.destinoNombre ?? 'its target'}`
			: estaPuesta(s.estado.estado)
				? dondeVisible(s.donde)
				: '—';

	/* Los filtros: cada desplegable ofrece solo lo que hay entre las trampas puestas. */
	let sensor = $state('');
	let tipo = $state('');
	let estado = $state('');
	const distintos = (valores: string[]) =>
		[...new Set(valores)].toSorted((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
	/* «Manual» al final: no es un sensor. */
	const sensores = $derived([
		...distintos(deGrupo.filter((s) => !s.aMano).map((s) => s.sensorNombre)),
		...(deGrupo.some((s) => s.aMano) ? [MANUAL] : [])
	]);
	const tipos = $derived(distintos(deGrupo.map((s) => s.tipo)));
	const estados = $derived(distintos(deGrupo.map((s) => s.estado.etiqueta)));
	const filtrando = $derived(Boolean(buscar.trim() || sensor || tipo || estado));

	/* El orden: clic en una cabecera ordena por ella; con Mayús se suma a las que ya había. */
	type Columna = 'nombre' | 'modulo' | 'sensor' | 'donde' | 'eventos' | 'estado';
	const columnas: { id: Columna; texto: string; num?: boolean }[] = [
		{ id: 'nombre', texto: 'Honeypot' },
		{ id: 'modulo', texto: 'Module' },
		{ id: 'sensor', texto: 'Sensor' },
		{ id: 'donde', texto: 'Location' },
		{ id: 'eventos', texto: 'Events 24 h', num: true },
		{ id: 'estado', texto: 'Status' }
	];
	const valores = {
		nombre: (s: Fila) => s.nombre,
		modulo: (s: Fila) => s.modulo,
		sensor: sensorDe,
		donde: dondeDe,
		eventos: (s: Fila) => s.eventos,
		estado: (s: Fila) => s.estado.etiqueta
	};
	let orden = $state<Clave<Columna>[]>([]);
	const puesto = (c: Columna) => orden.findIndex((k) => k.columna === c);

	const visibles = $derived.by(() => {
		const filtradas = deGrupo.filter(
			(s) =>
				(!sensor || sensorDe(s) === sensor) &&
				(!tipo || s.tipo === tipo) &&
				(!estado || s.estado.etiqueta === estado) &&
				casa(
					`${s.nombre} ${s.id} ${s.modulo} ${nombreTipo[s.tipo]} ${s.aMano ? (s.destinoNombre ?? '') : s.sensorNombre} ${s.aMano ? '' : dondeDe(s)} ${s.plantillaNombre ?? ''}`,
					buscar
				)
		);
		return ordenar(filtradas, orden, valores);
	});

	/* Lo desplegado por un lado y cuánto ruido hace por otro. */
	const PESTANAS = [
		{ id: 'honeypots', texto: 'Honeypots' },
		{ id: 'noise', texto: 'Noise' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));
	/* Primero los que más ruido hacen. */
	const ruidosas = $derived(
		(data.ruido?.trampas ?? []).toSorted(
			(a, b) => noAccionables(b) - noAccionables(a) || b.eventos - a.eventos
		)
	);
</script>

<svelte:head>
	<title>Honeypots — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Honeypots</h1>
	<div class="botones">
		{#if data.conPlantillas}
			<a class="boton" href={plantillas}>Templates</a>
		{/if}
		{#if opera}
			<a class="boton principal" href={resolve('/decoys/catalog')}>Deploy a honeypot</a>
		{/if}
	</div>
</div>

{#if form?.mensaje}
	<p class="ok" role="status">{form.mensaje}</p>
{/if}
{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{/if}

{#if data.creado}
	<p class="ok" role="status">Honeypot <b>{data.creado}</b> sent to the sensor.</p>
{/if}

{#if data.quitada}
	<p class="ok" role="status">Honeypot <b>{data.quitada}</b> removed. Its events are kept.</p>
{/if}

{#if data.cambiado}
	<p class="ok" role="status">
		Settings for <b>{data.cambiado}</b> saved. The sensor rebuilds the honeypot in under a minute.
	</p>
{/if}

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Honeypot sections" />

<div hidden={pestana !== 'honeypots'}>
	{#if data.desplegados.length}
		<div class="filtros">
			<input
				type="search"
				bind:value={buscar}
				placeholder="Search your honeypots: name, module, sensor or location"
				aria-label="Search your honeypots"
			/>
			<select bind:value={sensor} aria-label="Filter by sensor">
				<option value="">All sensors</option>
				{#each sensores as n (n)}
					<option value={n}>{n}</option>
				{/each}
			</select>
			<select bind:value={tipo} aria-label="Filter by type">
				<option value="">All types</option>
				{#each tipos as t (t)}
					<option value={t}>{nombreTipo[t]}</option>
				{/each}
			</select>
			<select bind:value={estado} aria-label="Filter by status">
				<option value="">All statuses</option>
				{#each estados as e (e)}
					<option value={e}>{e}</option>
				{/each}
			</select>
			{#if filtrando || orden.length}
				<button
					type="button"
					class="boton"
					onclick={() => {
						buscar = sensor = tipo = estado = '';
						orden = [];
					}}>Clear</button
				>
			{/if}
			<span class="cuenta mono" role="status">
				{visibles.length === deGrupo.length
					? `${deGrupo.length}`
					: `${visibles.length} of ${deGrupo.length}`}
			</span>
			{#if data.grupos.length}
				<div class="pestanas" role="group" aria-label="Honeypots by template">
					<a href={resolve('/decoys')} aria-current={data.plantilla ? undefined : 'true'}>All</a>
					{#each data.grupos as g (g.id)}
						<a href={enGrupo(g.id)} aria-current={data.plantilla === g.id ? 'true' : undefined}
							>{g.nombre}</a
						>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if grupo}
		<div class="grupo">
			<p>
				Honeypots deployed from the template <b>{grupo.nombre}</b>:
				<span class="mono">{deGrupo.length}</span>
			</p>
			<div class="botones">
				<a class="boton" href={`${plantillas}/${encodeURIComponent(grupo.id)}`}>Open the template</a
				>
				{#if opera}
					<form
						method="POST"
						action="?/retirarGrupo"
						use:enhance
						onsubmit={(e) => {
							if (!confirm(`Remove the ${deGrupo.length} honeypots of "${grupo.nombre}"?`))
								e.preventDefault();
						}}
					>
						<input type="hidden" name="plantilla" value={grupo.id} />
						<button class="boton peligro">Remove all</button>
					</form>
				{/if}
			</div>
		</div>
	{/if}

	<section class="panel">
		<table>
			<thead>
				<tr>
					{#each columnas as c (c.id)}
						{@const i = puesto(c.id)}
						<th
							class:num={c.num}
							aria-sort={i < 0
								? undefined
								: orden[i].sentido === 'asc'
									? 'ascending'
									: 'descending'}
						>
							<button
								type="button"
								class="ordenar"
								class:activa={i >= 0}
								title="Click to sort. Shift + click to sort by several columns."
								onclick={(e) => (orden = alternar(orden, c.id, e.shiftKey))}
							>
								{c.texto}
								<span class="flecha" aria-hidden="true"
									>{i < 0
										? '↕'
										: orden[i].sentido === 'asc'
											? '↑'
											: '↓'}{#if orden.length > 1 && i >= 0}<sup>{i + 1}</sup>{/if}</span
								>
							</button>
						</th>
					{/each}
					{#if opera}<th></th>{/if}
				</tr>
			</thead>
			<tbody>
				{#each visibles as s (s.id)}
					<tr>
						<td>
							<div class="nombre">
								<LogoTrampa procedencia={s.procedencia} pictograma={s.pictograma} />
								<b>{s.nombre}</b>
								<span class="tag">{nombreTipo[s.tipo]}</span>
								{#if s.plantilla && !data.plantilla}
									<a
										class="de-plantilla"
										href={enGrupo(s.plantilla)}
										title="Deployed from this template">{s.plantillaNombre}</a
									>
								{/if}
							</div>
						</td>
						<td class="mono">{s.modulo}</td>
						<!-- Una trampa a mano no la pone ningún sensor: la pones tú en su destino. -->
						<td>{sensorDe(s)}</td>
						<!-- Dónde escucha, si ya está puesta; mientras su sensor la pone, lo dice su estado. -->
						<td class="donde" class:mono={!s.aMano}>{dondeDe(s)}</td>
						<td class="num mono" class:caliente={s.eventos > 0}>{s.eventos}</td>
						<!-- Lo que ve el cliente (§8.2): activa solo si está comprobada. -->
						<td class="estado">
							<EstadoTrampa estado={s.estado} motivo />
							{#if s.silencios.length}
								<small
									class="silencio"
									title="Set on the Alerts tab of this honeypot or of its sensor"
									>Alerts muted: {s.silencios.join(', ')}</small
								>
							{/if}
						</td>
						{#if opera}
							<td class="acciones">
								<a class="boton" href={resolve('/decoys/[id]', { id: s.id })}
									>{s.aMano ? 'Steps' : 'Settings'}</a
								>
								<!-- Activa y sin comprobar: «Probar» es lo siguiente (§8.3). La ficha dice cómo. -->
								{#if s.estado.estado === 'colocada'}
									<a class="boton" href={`${resolve('/decoys/[id]', { id: s.id })}#probar`}>Test</a>
								{/if}
								{#if s.pausable}
									<form method="POST" action="?/estado" use:enhance>
										<input type="hidden" name="id" value={s.id} />
										<input type="hidden" name="activo" value={s.activo ? 'no' : 'si'} />
										<button class="boton">{s.activo ? 'Pause' : 'Resume'}</button>
									</form>
								{/if}
								{#if s.colocacion !== 'retirando'}
									<form method="POST" action="?/retirar" use:enhance>
										<input type="hidden" name="id" value={s.id} />
										<button class="boton peligro">Remove</button>
									</form>
								{/if}
							</td>
						{/if}
					</tr>
				{:else}
					<tr>
						<td class="vacio-fila" colspan={opera ? 7 : 6}>
							{filtrando
								? 'No honeypot matches these filters.'
								: 'No honeypots deployed yet. Add one from the catalog.'}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
</div>

{#if pestana === 'noise' && data.ruido}
	{@const porMil = ruidoPorMil(ruidosas, data.ruido.dias)}
	<section class="panel ruido">
		<h2>Noise in the last {data.ruido.dias} days</h2>
		<p class="ayuda">
			How much of what your honeypots receive did not call for any action: visits from known
			scanners and events someone marked as a false positive. Console tests are left out. The fewer
			of these, the more a single alert means.
		</p>
		<p class="cifra">
			<b class="mono">{porMil === null ? '—' : porMil.toLocaleString('en-GB')}</b>
			non-actionable events per 1,000 honeypots per month
		</p>
		{#if ruidosas.length}
			<table>
				<thead>
					<tr>
						<th>Honeypot</th>
						<th class="num">Events</th>
						<th class="num">Known scanners</th>
						<th class="num">False positives</th>
						<th class="num">Confirmed</th>
						<th class="num">Noise</th>
					</tr>
				</thead>
				<tbody>
					{#each ruidosas as r (r.id)}
						<tr>
							<td>
								<a href={resolve('/decoys/[id]', { id: r.id })}>{r.nombre}</a>
								<small class="mono">{r.modulo}</small>
							</td>
							<td class="num mono">{r.eventos}</td>
							<td class="num mono">{r.escaner}</td>
							<td class="num mono">{r.falsosPositivos}</td>
							<td class="num mono">{r.confirmados}</td>
							<td class="num mono">{porcentaje(parteDeRuido(r))}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="ayuda">
				"False positives" and "Confirmed" come from the mark each event gets when someone reviews it
				(Events → mark as false positive or as interesting). Events nobody has reviewed count in
				"Events" only.
			</p>
		{:else}
			<p class="ayuda">There are no honeypots yet.</p>
		{/if}
	</section>
{/if}

<style>
	.ruido {
		padding: 18px 20px 20px;
	}

	.ruido h2 {
		font-size: 16px;
		font-weight: 600;
	}

	.ruido .cifra {
		margin: 12px 0 16px;
		color: var(--ink-2);
	}

	.ruido .cifra b {
		font-size: 26px;
		color: var(--ink);
		margin-right: 8px;
	}

	.ruido td small {
		display: block;
		color: var(--ink-3);
	}

	.ruido .ayuda {
		max-width: 80ch;
	}

	.cabecera {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.ok,
	.error {
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
	}

	.ok {
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
		border: 1px solid color-mix(in oklab, var(--crit) 40%, var(--line));
	}

	.filtros {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 16px;
		margin: 0 0 16px;
	}

	.filtros input {
		flex: 1 1 260px;
		max-width: 420px;
	}

	.filtros select {
		flex: 0 1 auto;
		width: auto;
		max-width: 220px;
	}

	.cuenta {
		font-size: 12px;
		color: var(--ink-3);
	}

	.botones {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	/* La cabecera entera es el botón de ordenar: mismo aspecto que el texto de antes. */
	.ordenar {
		all: unset;
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
		cursor: pointer;
		user-select: none;
	}

	.ordenar:hover,
	.ordenar.activa {
		color: var(--ink);
	}

	.ordenar:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
		border-radius: 3px;
	}

	.flecha {
		font-size: 11px;
		opacity: 0.45;
	}

	.activa .flecha {
		opacity: 1;
		color: var(--accent);
	}

	.flecha sup {
		font-size: 9px;
		margin-left: 1px;
	}

	.pestanas {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.pestanas a {
		padding: 6px 13px;
		border-radius: 99px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
	}

	.pestanas a[aria-current='true'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.grupo {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 0 0 16px;
		font-size: 13.5px;
	}

	.grupo p {
		margin: 0;
	}

	.de-plantilla {
		font-size: 11.5px;
		color: var(--ink-3);
		white-space: nowrap;
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
		white-space: nowrap;
	}

	td {
		padding: 11px 16px;
		border-bottom: 1px solid var(--line);
		vertical-align: middle;
	}

	tr:last-child td {
		border-bottom: none;
	}

	.nombre {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	td b {
		font-weight: 600;
	}

	.acciones {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	.num {
		text-align: right;
	}

	.donde {
		font-size: 12px;
		color: var(--ink-2);
	}

	.caliente {
		color: var(--warn);
		font-weight: 600;
	}

	.silencio {
		display: block;
		margin-top: 3px;
		font-size: 11.5px;
		color: var(--warn, var(--ink-3));
	}

	.estado {
		min-width: 16ch;
		max-width: 32ch;
	}

	.vacio-fila {
		text-align: center;
		color: var(--ink-3);
		padding: 18px 16px;
	}
</style>
