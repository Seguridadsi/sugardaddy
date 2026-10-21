<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { nombreTipoDestino } from '$lib/destinos';
	import { haceCuanto } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data } = $props();
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));
</script>

<svelte:head>
	<title>Destinos — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<h1>Destinos</h1>
		<p class="intro">
			Los sitios donde se pueden poner trampas. Las máquinas con sensor aparecen solas; un servidor,
			un NAS o una cuenta de nube sin sensor los describes tú.
		</p>
	</div>
	{#if opera}
		<a class="boton principal" href={resolve('/destinos/nuevo')}>Añadir destino</a>
	{/if}
</div>

{#if data.baja}<p class="ok" role="status">Destino dado de baja.</p>{/if}

{#if data.destinos.length}
	<ul class="panel lista">
		{#each data.destinos as d (d.id)}
			<li>
				<div class="quien">
					<a class="nombre" href={resolve('/destinos/[id]', { id: d.id })}>{d.nombre}</a>
					<span class="tag">{nombreTipoDestino(d.tipo)}</span>
					{#if !d.activo}<span class="tag">dado de baja</span>{/if}
					<small>{d.plataforma ?? 'Sin datos de su sistema'}</small>
				</div>
				<div class="sensor">
					{#if d.sensor}
						<a href={resolve('/sensores')}>{d.sensor.nombre}</a>
						<span class="estado" class:mal={!d.sensor.vivo}>
							{d.sensor.vivo
								? 'en línea'
								: d.sensor.ultimoLatido
									? `sin contacto ${haceCuanto(d.sensor.ultimoLatido, data.ahora)}`
									: 'nunca ha contactado'}
						</span>
					{:else}
						<span class="sin">Sin sensor</span>
					{/if}
					{#each d.avisos as a (a.codigo)}
						<small class="aviso" class:grave={a.gravedad === 'error'} title={a.texto}
							>{a.titulo}</small
						>
					{/each}
				</div>
				<div class="trampas mono">
					{d.trampas}
					<small>{d.trampas === 1 ? 'trampa' : 'trampas'}</small>
				</div>
			</li>
		{/each}
	</ul>
{:else}
	<p class="panel vacio">
		Aún no hay destinos. Cada sensor trae el suyo: aparecerá aquí en cuanto des de alta uno.
	</p>
{/if}

<style>
	.cabecera {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px 20px;
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.intro {
		max-width: 70ch;
		margin: 6px 0 0;
		color: var(--ink-2);
		font-size: 14px;
	}

	.ok {
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
	}

	.lista {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.lista li {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 90px;
		gap: 6px 18px;
		align-items: center;
		padding: 13px 18px;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	.lista li:last-child {
		border-bottom: none;
	}

	.quien {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		min-width: 0;
	}

	.nombre {
		font-weight: 600;
		font-size: 14.5px;
		color: var(--ink);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.nombre:hover {
		color: var(--accent);
	}

	.quien small {
		flex-basis: 100%;
		font-size: 12px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.sensor {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.sensor a {
		margin-right: 8px;
	}

	.estado {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ok);
	}

	.estado.mal {
		color: var(--crit);
	}

	.sin {
		color: var(--ink-3);
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

	.trampas {
		text-align: right;
		font-size: 15px;
	}

	.trampas small {
		display: block;
		font-family: var(--font-body);
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.vacio {
		padding: 16px 18px;
		color: var(--ink-2);
	}

	@media (max-width: 760px) {
		.lista li {
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.sensor {
			grid-column: 1 / -1;
			grid-row: 2;
		}

		.trampas {
			grid-column: 2;
			grid-row: 1;
		}
	}
</style>
