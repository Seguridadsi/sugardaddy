<!--
	El alcance de las salidas en un sensor o en un honeypot (lib/alcance.ts): por
	cada canal, si lo suyo sale por él, no sale o hace lo que diga el nivel de
	arriba. Cada fila se guarda sola, al cambiarla.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';

	type Fila = {
		id: string;
		nombre: string;
		tipo: string;
		activa: boolean;
		valor: 'hereda' | 'si' | 'no';
		heredado: { envia: boolean; de: 'sensor' | 'consola' };
	};
	let {
		filas,
		que,
		puede = true
	}: {
		filas: Fila[];
		/* De quién se habla, para los textos: «this sensor», «this honeypot». */
		que: string;
		puede?: boolean;
	} = $props();

	const efectivo = (f: Fila) => (f.valor === 'hereda' ? f.heredado.envia : f.valor === 'si');
	const DE = { sensor: 'its sensor', consola: 'the console' } as const;
</script>

<section class="panel bloque">
	<h2>Alerts</h2>
	<p class="ayuda">
		For each output, whether what comes from {que} goes out through it: events, incidents, health alerts
		and what Response does. "Inherit" follows the level above. Nothing stops being recorded: it is all
		still in the console.
	</p>
	{#if filas.length === 0}
		<p class="ayuda">
			There are no outputs yet. Add one in <a href={resolve('/alerts')}>Alerts & SIEM</a>.
		</p>
	{:else}
		<table>
			<thead>
				<tr><th>Output</th><th>From {que}</th><th>Now</th></tr>
			</thead>
			<tbody>
				{#each filas as f (f.id)}
					<tr>
						<td>
							<a href={`${resolve('/alerts')}/${f.id}`}>{f.nombre}</a>
							{#if !f.activa}<small> · paused</small>{/if}
						</td>
						<td>
							<form method="POST" action="?/alcance" use:enhance>
								<input type="hidden" name="salida" value={f.id} />
								<select
									name="envia"
									aria-label="Alerts through {f.nombre}"
									disabled={!puede}
									onchange={(ev) => ev.currentTarget.form?.requestSubmit()}
								>
									<option value="" selected={f.valor === 'hereda'}
										>Inherit from {DE[f.heredado.de]} ({f.heredado.envia
											? 'send'
											: 'do not send'})</option
									>
									<option value="si" selected={f.valor === 'si'}>Send</option>
									<option value="no" selected={f.valor === 'no'}>Do not send</option>
								</select>
							</form>
						</td>
						<td class:callado={!efectivo(f)}>{efectivo(f) ? 'Sends' : 'Silent'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.bloque {
		margin-bottom: 16px;
		padding: 18px 20px 20px;
		max-width: 760px;
	}
	h2 {
		font-size: 15px;
		margin: 0 0 6px;
	}
	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 0 0 12px;
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
		padding: 6px 12px 6px 0;
		border-bottom: 1px solid var(--line);
	}
	td {
		padding: 8px 12px 8px 0;
		border-bottom: 1px solid var(--line);
		vertical-align: middle;
	}
	tr:last-child td {
		border-bottom: none;
	}
	.callado {
		color: var(--crit);
		font-weight: 600;
	}
</style>
