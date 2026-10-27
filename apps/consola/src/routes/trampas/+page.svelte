<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import EstadoTrampa from '$lib/components/EstadoTrampa.svelte';
	import LogoTrampa from '$lib/components/LogoTrampa.svelte';
	import { nombreTipo } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));

	/* El catálogo: todas o solo las disponibles, y lo que se escriba en el buscador. */
	let soloDisponibles = $state(false);
	let buscar = $state('');
	const llano = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
	const disponibles = $derived(data.catalogo.filter((m) => m.disponible).length);
	const visibles = $derived.by(() => {
		const q = llano(buscar.trim());
		return data.catalogo.filter(
			(m) =>
				(!soloDisponibles || m.disponible) &&
				(!q || llano(`${m.nombre} ${m.id} ${nombreTipo[m.tipo]} ${m.resumen}`).includes(q))
		);
	});
</script>

<svelte:head>
	<title>Trampas — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<h1>Trampas</h1>
	</div>
</div>

{#if form?.mensaje}
	<p class="ok" role="status">{form.mensaje}</p>
{/if}
{#if form?.error}
	<p class="error" role="alert">{form.error}</p>
{/if}

{#if data.creado}
	<p class="ok" role="status">Trampa <b>{data.creado}</b> enviada al sensor.</p>
{/if}

{#if data.quitada}
	<p class="ok" role="status">Trampa <b>{data.quitada}</b> retirada. Sus eventos se conservan.</p>
{/if}

{#if data.cambiado}
	<p class="ok" role="status">
		Ajustes de <b>{data.cambiado}</b> guardados. El sensor rehace la trampa en menos de un minuto.
	</p>
{/if}

<section class="panel">
	<table>
		<thead>
			<tr>
				<th>Trampa</th>
				<th>Módulo</th>
				<th>Sensor</th>
				<th>Dónde</th>
				<th class="num">Eventos 24 h</th>
				<th>Estado</th>
				{#if opera}<th></th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each data.desplegados as s (s.id)}
				<tr>
					<td>
						<div class="nombre">
							<LogoTrampa procedencia={s.procedencia} pictograma={s.pictograma} />
							<b>{s.nombre}</b>
							<span class="tag">{nombreTipo[s.tipo]}</span>
						</div>
					</td>
					<td class="mono">{s.modulo}</td>
					<!-- Una trampa a mano no la pone ningún sensor: la pones tú en su destino. -->
					<td>{s.aMano ? 'A mano' : s.sensorNombre}</td>
					{#if s.aMano}
						<td class="donde">en {s.destinoNombre ?? 'su destino'}</td>
					{:else}
						<td class="mono donde">{s.donde}</td>
					{/if}
					<td class="num mono" class:caliente={s.eventos > 0}>{s.eventos}</td>
					<!-- Lo que ve el cliente (§8.2): activa solo si está comprobada. -->
					<td class="estado"><EstadoTrampa estado={s.estado} motivo /></td>
					{#if opera}
						<td class="acciones">
							<a class="boton" href={resolve('/trampas/[id]', { id: s.id })}
								>{s.aMano ? 'Pasos' : 'Ajustes'}</a
							>
							<!-- Puesta y sin comprobar: «Probar» es lo siguiente (§8.3). La ficha dice cómo. -->
							{#if s.estado.estado === 'colocada'}
								<a class="boton" href={`${resolve('/trampas/[id]', { id: s.id })}#probar`}>Probar</a
								>
							{/if}
							{#if s.pausable}
								<form method="POST" action="?/estado" use:enhance>
									<input type="hidden" name="id" value={s.id} />
									<input type="hidden" name="activo" value={s.activo ? 'no' : 'si'} />
									<button class="boton">{s.activo ? 'Parar' : 'Reanudar'}</button>
								</form>
							{/if}
							{#if s.colocacion !== 'retirando'}
								<form method="POST" action="?/retirar" use:enhance>
									<input type="hidden" name="id" value={s.id} />
									<button class="boton peligro">Retirar</button>
								</form>
							{/if}
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</section>

<h2 class="seccion">Catálogo</h2>

<div class="filtros">
	<div class="pestanas" role="group" aria-label="Qué trampas ver">
		<button type="button" aria-pressed={!soloDisponibles} onclick={() => (soloDisponibles = false)}>
			Todas <span class="mono">{data.catalogo.length}</span>
		</button>
		<button type="button" aria-pressed={soloDisponibles} onclick={() => (soloDisponibles = true)}>
			Disponibles <span class="mono">{disponibles}</span>
		</button>
	</div>
	<input
		type="search"
		bind:value={buscar}
		placeholder="Buscar una trampa: nombre, tipo o qué detecta"
		aria-label="Buscar en el catálogo"
	/>
</div>

<div class="catalogo">
	{#each visibles as m (m.id)}
		<article class="panel modulo" class:fuera={!m.disponible}>
			<header>
				<span class="tag on">{nombreTipo[m.tipo]}</span>
				{#if m.disponible}
					<span class="incluida">Disponible</span>
				{:else}
					<span class="no-incluida">{m.porQueNo}</span>
				{/if}
			</header>
			<div class="titulo">
				<LogoTrampa procedencia={m.procedencia} pictograma={m.pictograma} grande />
				<h3>{m.nombre}</h3>
			</div>
			<p class="desc">{m.resumen}</p>
			<div class="acciones-modulo">
				<a class="boton" href={resolve('/trampas/catalogo/[modulo]', { modulo: m.id })}>Ver ficha</a
				>
				{#if m.disponible && m.desplegable && opera}
					<a class="boton principal" href={resolve('/trampas/nueva/[modulo]', { modulo: m.id })}
						>Desplegar</a
					>
				{/if}
			</div>
		</article>
	{:else}
		<p class="vacio">
			{buscar.trim()
				? `Ninguna trampa encaja con «${buscar.trim()}».`
				: 'Aún no tienes ninguna trampa disponible.'}
		</p>
	{/each}
</div>

<style>
	.cabecera {
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

	.estado {
		min-width: 16ch;
		max-width: 32ch;
	}

	.seccion {
		font-size: 18px;
		font-weight: 600;
		margin: 32px 0 4px;
	}

	.filtros {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 16px;
		margin: 12px 0 16px;
	}

	.pestanas {
		display: flex;
		gap: 4px;
	}

	.pestanas button {
		padding: 7px 14px;
		border: 0;
		border-radius: 99px;
		background: none;
		font: inherit;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink-2);
		cursor: pointer;
	}

	.pestanas button span {
		color: var(--ink-3);
		margin-left: 4px;
	}

	.pestanas button[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.filtros input {
		flex: 1 1 260px;
		max-width: 420px;
	}

	.vacio {
		grid-column: 1 / -1;
		color: var(--ink-3);
	}

	.catalogo {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
	}

	.modulo {
		display: flex;
		flex-direction: column;
		padding: 16px 18px 18px;
	}

	.modulo header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.titulo {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 12px;
	}

	.modulo h3 {
		font-size: 17px;
	}

	.desc {
		font-size: 13.5px;
		color: var(--ink-2);
		margin: 6px 0 12px;
	}

	.modulo .boton {
		margin-top: auto;
		align-self: flex-start;
	}

	.modulo.fuera {
		opacity: 0.75;
	}

	.incluida,
	.no-incluida {
		font-size: 11.5px;
		font-weight: 600;
	}

	.incluida {
		color: var(--ok);
	}

	.no-incluida {
		color: var(--ink-3);
	}

	.acciones-modulo {
		display: flex;
		gap: 8px;
		margin-top: auto;
		padding-top: 12px;
	}
</style>
