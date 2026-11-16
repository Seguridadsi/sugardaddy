<script lang="ts">
	import { page } from '$app/state';
	import { pestanaDe } from '$lib/pestanas';
	import { fechaHora } from '$lib/fechas-pantalla';
	import MenuAjustes from '$lib/components/MenuAjustes.svelte';
	import Pestanas from '$lib/components/Pestanas.svelte';

	let { data, form } = $props();

	/* El estado de los sensores (datos) por un lado; la política (configuración), por otro. */
	const PESTANAS = [
		{ id: 'sensors', texto: 'Sensors' },
		{ id: 'policy', texto: 'Policy' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));

	const ESTADO = {
		'en-uso': 'In use',
		'caduca-pronto': 'In use, renewal due',
		'sin-usar': 'Issued, not presented yet',
		'sin-certificado': 'No certificate (token only)',
		caducado: 'Expired'
	} as const;
	const pendientes = $derived(
		data.sensores.filter((s) => s.estado !== 'en-uso' && s.estado !== 'caduca-pronto')
	);
	let cortar = $state(false);
</script>

<svelte:head>
	<title>Sensor certificates — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Settings</h1>
</div>

<MenuAjustes actual="sensor-certificates" />

<p class="ayuda intro">
	Remote sensors authenticate to this console with their token and a client certificate issued by
	the console's own remote sensor CA (mutual TLS). Certificates last 90 days and each sensor renews
	its own before it expires. Removing a sensor revokes its certificate.
</p>

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Sensor certificate sections" />

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if page.url.searchParams.has('guardada')}<p class="mensaje" role="status">Policy saved.</p>{/if}

{#if data.sinClave}
	<p class="error" role="alert">
		This node has no key for encrypting secrets (CLAVE_SECRETOS), so it cannot keep a CA key: remote
		sensors connect with their token only. Update the node to get one.
	</p>
{/if}

{#if pestana === 'sensors'}
	<section class="panel bloque">
		{#if data.sensores.length === 0}
			<p class="ayuda">There are no remote sensors.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Sensor</th>
						<th>Certificate</th>
						<th>Expires</th>
						<th>First presented</th>
					</tr>
				</thead>
				<tbody>
					{#each data.sensores as s (s.id)}
						<tr>
							<td>{s.nombre} <small class="mono">{s.id}</small></td>
							<td>
								<span
									class="estado"
									class:bien={s.estado === 'en-uso'}
									class:mal={s.estado !== 'en-uso'}>{ESTADO[s.estado]}</span
								>
								{#if s.huella}<br /><small class="mono" title="SHA-256 fingerprint"
										>{s.huella.slice(0, 16)}…</small
									>{/if}
							</td>
							<td>{s.hasta ? fechaHora(s.hasta) : '—'}</td>
							<td>{s.visto ? fechaHora(s.visto) : '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if pendientes.length}
				<p class="ayuda">
					A sensor without a certificate was installed before mutual TLS: it gets one by itself
					after updating to this version. A sensor whose certificate was issued but never presented
					runs a version that does not use it yet, or the console's HTTPS is not asking for it yet
					(it starts within a few minutes of the update).
				</p>
			{/if}
		{/if}
	</section>
{:else}
	<section class="panel bloque">
		<h2>Remote sensors without a certificate</h2>
		<p class="ayuda">
			<strong>Grace</strong>: a sensor that has never presented its certificate still connects with
			its token only, and this console warns about it. Once a sensor has connected with its
			certificate, it can no longer connect without it.<br />
			<strong>Require</strong>: no remote sensor connects without a valid certificate. Use it once
			every sensor shows "In use".
		</p>
		{#if data.ca}
			<p class="ayuda">
				Remote sensor CA fingerprint (SHA-256): <code class="mono">{data.ca.huella}</code>
			</p>
		{/if}
		<form method="POST" action="?/politica">
			<fieldset>
				<label
					><input type="radio" name="politica" value="grace" checked={data.politica === 'grace'} />
					Grace (allow token only, with a warning)</label
				>
				<label
					><input
						type="radio"
						name="politica"
						value="require"
						checked={data.politica === 'require'}
					/> Require a client certificate</label
				>
			</fieldset>
			{#if pendientes.length && data.politica !== 'require'}
				<label class="cortar"
					><input type="checkbox" name="cortar" value="si" bind:checked={cortar} />
					I understand that {pendientes.map((p) => p.nombre).join(', ')} will lose contact with the console
					and will need a new install line.</label
				>
			{/if}
			<p><button class="boton" type="submit">Save policy</button></p>
		</form>
	</section>
{/if}

<style>
	.intro {
		max-width: 760px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 14px;
	}

	th,
	td {
		padding: 8px 10px;
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid var(--line);
	}

	fieldset {
		display: grid;
		gap: 8px;
		margin: 0 0 12px;
		padding: 0;
		border: 0;
	}

	.cortar {
		display: block;
		margin-bottom: 12px;
	}

	.estado.bien {
		color: var(--ok, inherit);
	}

	.estado.mal {
		color: var(--warn);
	}
</style>
