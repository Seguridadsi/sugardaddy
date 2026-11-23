<script lang="ts">
	/*
	 * El inventario de colocaciones (D7): cada copia de un cebo puesta en algún sitio, con su
	 * ruta exacta, la versión de su plantilla, cuándo se sembró, su caducidad, su rotación y
	 * su retirada. La usan la pestaña Placements de Honeypots y la ficha de cada uno.
	 */
	import { resolve } from '$app/paths';
	import { fechaCorta, fechaHoraLarga } from '$lib/fechas-pantalla';

	type Fila = {
		id: string;
		trampa: string | null;
		trampaNombre: string;
		modulo: string;
		destinoNombre: string | null;
		ejecutor: string;
		ubicacion: string;
		web: string | null;
		plantillaVersion: string | null;
		estado: string;
		etiqueta: string;
		sembrada: string | null;
		vista: string | null;
		caduca: string | null;
		rotarDias: number | null;
		rotarEl: string | null;
		caducada: boolean;
		rotacionVencida: boolean;
		sustituye: string | null;
		retirada: string | null;
		retiradaPor: string | null;
	};
	type Props = { filas: Fila[]; conTrampa?: boolean };
	let { filas, conTrampa = true }: Props = $props();

	const COMO: Record<string, string> = {
		'manual@1': 'Manual steps',
		'graph@1': 'Microsoft 365 connection'
	};
	/* Solo enlaces a SharePoint u OneDrive: lo demás es una ruta, no una dirección. */
	const enlazable = (w: string | null) =>
		!!w && /^https:\/\/[a-z0-9-]+\.sharepoint\.com\//i.test(w);
</script>

<table class="colocaciones">
	<thead>
		<tr>
			{#if conTrampa}<th>Honeypot</th>{/if}
			<th>Exact location</th>
			<th>Template</th>
			<th>Placed</th>
			<th>Expires</th>
			<th>Rotation</th>
			<th>Status</th>
		</tr>
	</thead>
	<tbody>
		{#each filas as c (c.id)}
			<tr class:cerrada={c.retirada !== null}>
				{#if conTrampa}
					<td>
						{#if c.trampa}
							<a href={resolve('/decoys/[id]', { id: c.trampa })}>{c.trampaNombre}</a>
						{:else}
							{c.trampaNombre}
						{/if}
						<small class="mono">{c.modulo}</small>
					</td>
				{/if}
				<td class="ruta">
					{#if enlazable(c.web)}
						<a class="mono" href={c.web} target="_blank" rel="noopener noreferrer">{c.ubicacion}</a>
					{:else}
						<span class="mono">{c.ubicacion}</span>
					{/if}
					<small
						>{c.destinoNombre ? `on ${c.destinoNombre} · ` : ''}{COMO[c.ejecutor] ?? c.ejecutor} ·
						<span class="mono" title="Placement ID">{c.id}</span></small
					>
				</td>
				<td class="mono">{c.plantillaVersion ?? 'before the inventory'}</td>
				<td>
					{#if c.sembrada}<span title={fechaHoraLarga(c.sembrada)}>{fechaCorta(c.sembrada)}</span
						>{:else}—{/if}
				</td>
				<td class:vencida={c.caducada}>
					{#if c.caduca}{fechaCorta(c.caduca)}{#if c.caducada}<small>expired</small
							>{/if}{:else}Never{/if}
				</td>
				<td class:vencida={c.rotacionVencida}>
					{#if c.rotarDias}
						Every {c.rotarDias} days
						{#if c.rotarEl}<small
								>{c.rotacionVencida ? 'due since' : 'next'} {fechaCorta(c.rotarEl)}</small
							>{/if}
					{:else}No{/if}
				</td>
				<td>
					<b class="estado {c.estado}">{c.etiqueta}</b>
					{#if c.retirada}<small>{c.retiradaPor ?? 'Removed'} · {fechaCorta(c.retirada)}</small
						>{:else if c.vista && c.ejecutor !== 'manual@1'}<small title={fechaHoraLarga(c.vista)}
							>checked {fechaCorta(c.vista)}</small
						>{/if}
					{#if c.sustituye}<small>replaces <span class="mono">{c.sustituye}</span></small>{/if}
				</td>
			</tr>
		{/each}
	</tbody>
</table>

<style>
	.colocaciones {
		width: 100%;
		border-collapse: collapse;
		font-size: 13.5px;
	}

	th {
		text-align: left;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-3);
		padding: 12px 12px 9px;
		border-bottom: 1px solid var(--line);
		white-space: nowrap;
	}

	td {
		padding: 10px 12px;
		border-bottom: 1px solid var(--line);
		vertical-align: top;
	}

	tr:last-child td {
		border-bottom: none;
	}

	small {
		display: block;
		margin-top: 3px;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.ruta {
		word-break: break-all;
		min-width: 220px;
	}

	.cerrada td {
		color: var(--ink-3);
	}

	.estado {
		font-weight: 600;
		white-space: nowrap;
	}

	.colocada {
		color: var(--ok);
	}

	.perdida,
	.vencida {
		color: var(--warn);
	}
</style>
