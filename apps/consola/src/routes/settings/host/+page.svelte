<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { pestanaDe } from '$lib/pestanas';
	import { fechaHora } from '$lib/fechas-pantalla';
	import MenuAjustes from '$lib/components/MenuAjustes.svelte';
	import Pestanas from '$lib/components/Pestanas.svelte';

	let { data, form } = $props();

	/* Lo que se ve de la máquina (datos) y el cortafuegos estricto (configuración). */
	const PESTANAS = [
		{ id: 'machine', texto: 'Machine' },
		{ id: 'integrity', texto: 'Integrity' },
		{ id: 'sensors', texto: 'Remote sensors' },
		{ id: 'firewall', texto: 'Strict firewall' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));

	const ESTADO: Record<string, string> = {
		aplicada: 'In place',
		quitada: 'Off',
		revertida: 'Rolled back: the node lost contact with this console after applying it',
		conflicto: 'Not applied: another firewall is active',
		'sin-nft': 'Not applied: the machine has no nftables',
		suspendida: 'Suspended: the console was opened in an emergency from the machine',
		error: 'Error'
	};
	const AUDITD: Record<string, string> = {
		puesta: 'Rules loaded',
		'no-instalado': 'auditd is not installed',
		fallo: 'Failed',
		desconocido: 'Unknown'
	};
	const modo = $derived(
		data.ajuste.estricto === undefined ? 'serie' : data.ajuste.estricto ? 'si' : 'no'
	);
</script>

<svelte:head>
	<title>Host — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Settings</h1>
</div>

<MenuAjustes actual="host" />

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Host sections" />

{#if form?.mensaje}<p class="mensaje" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

{#if pestana === 'machine'}
	{#if !data.hechos}
		<section class="panel bloque">
			<p class="ayuda">
				The updater has not reported on this machine yet. It looks every 30 minutes; a node on a
				version before this feature does not report.
			</p>
		</section>
	{:else}
		<section class="panel bloque">
			<h2>Docker</h2>
			<p class:mal={data.hechos.docker.desfasada}>
				{data.hechos.docker.version ?? 'Unknown version'}
				{#if data.hechos.docker.fijada}
					· this release was tested with {data.hechos.docker.fijada}
					{#if data.hechos.docker.desfasada}(older: update it){/if}
				{/if}
			</p>
			<p class="ayuda">
				{#if data.hechos.appliance}
					On the appliance the node updates Docker by itself to the version in its signed release,
					checking each package against its signed checksum.
				{:else}
					Docker on this machine is managed by you: the node only warns when it is older than the
					tested version.
				{/if}
				{#if data.hechos.docker.detalle}{data.hechos.docker.detalle}{/if}
			</p>
		</section>

		<section class="panel bloque">
			<h2>SSH</h2>
			<p class:mal={data.hechos.ssh.activo}>
				The SSH service is {data.hechos.ssh.activo ? 'running' : 'not running'}.
			</p>
			{#if data.hechos.ssh.usuarios.length}
				<ul class="lista">
					{#each data.hechos.ssh.usuarios as u (u.usuario)}
						<li>
							<b>{u.usuario}</b>
							<small>uid {u.uid} · {u.claves} authorized {u.claves === 1 ? 'key' : 'keys'}</small>
							{#each u.huellas as h (h)}<code>{h}</code>{/each}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="ayuda">No user has authorized SSH keys.</p>
			{/if}
			<p class="ayuda">
				Changes to these keys, to sudoers, to the SSH configuration and to users are recorded in the
				audit log and sent to your SIEM as integridad.anfitrion.
			</p>
		</section>

		<section class="panel bloque">
			<h2>Host audit (auditd)</h2>
			<p class:mal={data.hechos.auditd.estado !== 'puesta'}>
				{AUDITD[data.hechos.auditd.estado] ?? data.hechos.auditd.estado}
			</p>
			{#if data.hechos.auditd.detalle}<p class="ayuda">{data.hechos.auditd.detalle}</p>{/if}
			<p class="ayuda">Last report {fechaHora(data.hechos.recibido)}.</p>
		</section>
	{/if}
{:else if pestana === 'integrity'}
	<section class="panel bloque">
		<h2>Integrity check</h2>
		<p class="ayuda">
			Every 10 minutes the updater compares this machine with the signed version installed: the
			signed configuration files, the images, the variables of <code>.env</code> and the image each
			container runs. A difference raises the <code>integridad.desviacion</code> alert.
		</p>
		{#if !data.integridad}
			<p class="ayuda">
				The updater has not reported a check yet (it is stopped, or the node runs a version before
				this feature).
			</p>
		{:else}
			<p class="integridad" class:mal={data.integridad.desviaciones.length > 0}>
				<b
					>{data.integridad.desviaciones.length
						? `${data.integridad.desviaciones.length} ${data.integridad.desviaciones.length === 1 ? 'difference' : 'differences'} from version ${data.integridad.version}`
						: `Matches version ${data.integridad.version}`}</b
				>
			</p>
			<p class="ayuda" class:mal={data.integridadVieja}>
				Last check: {fechaHora(data.integridad.comprobado)}{data.integridadVieja
					? ' — more than 30 minutes ago: the updater may be stopped'
					: ''}.
			</p>
			{#if data.integridad.desviaciones.length}
				<ul class="desviaciones">
					{#each data.integridad.desviaciones as d, i (i)}
						<li><span class="mono">{d.tipo}</span> {d.detalle}</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>
{:else if pestana === 'sensors'}
	<section class="panel bloque">
		<h2>Remote sensor machines</h2>
		<p class="ayuda">
			Each remote sensor's updater applies the same strict firewall setting on its own machine
			(without a console port: only its decoys and SSH from the ranges you allow get in), loads the
			same audit rules and reports SSH access and its Docker version. It looks every 30 minutes.
		</p>
		{#if !data.sensores.length}
			<p class="ayuda">There are no remote sensors.</p>
		{:else}
			<ul class="lista sensores">
				{#each data.sensores as m (m.id)}
					<li>
						<b>{m.nombre}</b>
						{#if !data.efectivo.activo && !m.estado}
							<small>Strict firewall off</small>
						{:else if m.viejo}
							<small class="mal">Strict firewall: no report for more than ten minutes</small>
						{:else if m.estado}
							<small class:mal={m.estado.estado !== 'aplicada' && m.estado.estado !== 'quitada'}
								>Strict firewall: {ESTADO[m.estado.estado] ?? m.estado.estado}</small
							>
						{/if}
						{#if m.hechos}
							<small class:mal={m.hechos.auditd.estado !== 'puesta'}
								>auditd: {AUDITD[m.hechos.auditd.estado] ?? m.hechos.auditd.estado}</small
							>
							<small class:mal={m.hechos.ssh.activo}
								>SSH {m.hechos.ssh.activo ? 'running' : 'not running'} · {m.hechos.ssh.usuarios
									.length}
								{m.hechos.ssh.usuarios.length === 1 ? 'user' : 'users'} with keys</small
							>
							<small class:mal={m.hechos.docker.desfasada}
								>Docker {m.hechos.docker.version ?? 'unknown'}{#if m.hechos.docker.desfasada}
									(older than {m.hechos.docker.fijada}){/if}</small
							>
							<small>Last report {fechaHora(m.hechos.recibido)}</small>
						{:else}
							<small>Its updater has not reported on its machine yet.</small>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{:else}
	<section class="panel bloque">
		<h2>Status</h2>
		{#if !data.efectivo.activo}
			<p>Off.</p>
		{:else if data.viejo}
			<p class="mal">
				On, but the updater has not reported for more than ten minutes{#if data.estado}: last known
					“{ESTADO[data.estado.estado] ?? data.estado.estado}”{/if}.
			</p>
		{:else if data.estado}
			<p class:mal={data.estado.estado !== 'aplicada'}>
				{ESTADO[data.estado.estado] ?? data.estado.estado}
			</p>
			{#if data.estado.detalle}<p class="ayuda">{data.estado.detalle}</p>{/if}
		{/if}
		{#if data.efectivo.deSerie && data.efectivo.motivo}
			<p class="ayuda">
				On by default: {data.efectivo.motivo === 'appliance'
					? 'this is the appliance'
					: 'the banking profile is applied'}.
			</p>
		{/if}
	</section>

	<section class="panel bloque">
		<h2>Strict host firewall</h2>
		<p class="ayuda">
			Denies everything by default on this machine: only the console port (for its access list), the
			ports of the node and its decoys, and SSH from the ranges below get in. Other containers'
			published ports are closed. If, after applying it, the node cannot reach this console within
			90 seconds, it goes back to the previous rules on its own. Not applied while UFW or firewalld
			are active. Remote sensors apply the same setting on their machines.
		</p>
		<form method="POST" action="?/guardar" use:enhance class="formulario">
			<fieldset>
				<legend>Mode</legend>
				<label
					><input type="radio" name="estricto" value="serie" checked={modo === 'serie'} /> Default (on
					for the appliance and with the banking profile)</label
				>
				<label><input type="radio" name="estricto" value="si" checked={modo === 'si'} /> On</label>
				<label><input type="radio" name="estricto" value="no" checked={modo === 'no'} /> Off</label>
			</fieldset>

			<label for="sshRedes"
				>SSH to this machine allowed from (one per line; empty: SSH closed)</label
			>
			<textarea id="sshRedes" name="sshRedes" rows="3" placeholder="192.0.2.0/24"
				>{data.ajuste.ssh.redes.join('\n')}</textarea
			>
			<label for="sshPuerto">SSH port of this machine</label>
			<input
				id="sshPuerto"
				name="sshPuerto"
				type="number"
				min="1"
				max="65535"
				value={data.ajuste.ssh.puerto}
			/>

			<label class="casilla"
				><input type="checkbox" name="restringida" checked={data.ajuste.salida.restringida} />
				Restrict outbound traffic</label
			>
			<p class="ayuda">
				Only to Central, the image registry, Microsoft sign-in (if used), the appliance package
				repositories, the destinations of your active outputs (SIEM, mail, webhooks… added on their
				own) and the destinations below, plus DNS and NTP. Behind a proxy, only the proxy. Remote
				sensors only reach this console, the image registry, their proxy and the destinations below.
			</p>
			<label for="destinos">Extra outbound destinations (host:port, one per line)</label>
			<textarea id="destinos" name="destinos" rows="3" placeholder="siem.example.com:6514"
				>{data.ajuste.salida.destinos.join('\n')}</textarea
			>
			{#if data.salida}
				{#if data.salida.deSalidas.length}
					<p class="ayuda">From your outputs: {data.salida.deSalidas.join(', ')}.</p>
				{/if}
				<p class="ayuda">Allowed now: {data.salida.destinos.join(', ') || 'none'}.</p>
			{/if}
			<button class="boton principal">Save</button>
		</form>
		{#if data.ajuste.por && data.ajuste.cuando}
			<p class="ayuda">Last changed by {data.ajuste.por} on {fechaHora(data.ajuste.cuando)}.</p>
		{/if}
	</section>
{/if}

<style>
	.integridad.mal,
	.ayuda.mal {
		color: var(--crit);
	}
	.desviaciones {
		margin: 8px 0 0;
		padding-left: 18px;
		font-size: 14px;
	}
	.cabecera {
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
	}

	.bloque {
		margin-bottom: 16px;
		padding: 18px 20px 20px;
		max-width: 760px;
	}

	h2 {
		font-size: 16px;
		font-weight: 600;
		margin-bottom: 6px;
	}

	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 8px 0 4px;
	}

	.mal {
		color: var(--crit);
	}

	.lista {
		list-style: none;
		padding: 0;
		margin: 10px 0 0;
		display: grid;
		gap: 8px;
	}

	.lista li {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		align-items: baseline;
	}

	.sensores li {
		display: grid;
		gap: 2px;
	}

	code {
		font-size: 12px;
		overflow-wrap: anywhere;
	}

	.formulario {
		display: grid;
		gap: 8px;
		margin-top: 12px;
	}

	fieldset {
		border: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}

	legend,
	.formulario > label {
		font-size: 13px;
		font-weight: 600;
	}

	.casilla {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	textarea,
	input[type='number'] {
		max-width: 100%;
	}
</style>
