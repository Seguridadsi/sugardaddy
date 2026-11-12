<script lang="ts">
	import { enhance } from '$app/forms';
	import { pendientes, type IdPaso, type Paso } from '$lib/configuracion-inicial';

	let { data, form } = $props();

	const TITULOS: Record<IdPaso, string> = {
		cuenta: 'Your account',
		acceso: 'Who can open the console',
		codigo: 'Emergency code',
		empresa: 'Your company',
		registro: 'Free registration',
		avisos: 'Alerts',
		certificado: 'Console certificate',
		trampa: 'Your first honeypot'
	};
	const ESTADOS = { hecho: 'Done', omitido: 'Skipped', pendiente: 'Pending' } as const;

	const h = $derived(data.hechos);
	const faltan = $derived(pendientes(data.pasos).length);
	const resueltos = $derived(data.pasos.length - faltan);
	/* El primero que falta se enseña abierto; los demás, con su estado y su enlace. */
	const siguiente = $derived(data.pasos.find((p: Paso) => p.estado === 'pendiente')?.id);
</script>

<svelte:head>
	<title>Setup — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<p class="eyebrow">{resueltos} of {data.pasos.length} steps</p>
		<h1>Setup</h1>
	</div>
</div>

<p class="entrada">
	{#if data.terminado}
		Setup is finished. You can review any step here whenever you need to.
	{:else}
		These steps leave your console ready. You can stop at any point and continue later: this page
		stays in the menu until you finish.
	{/if}
</p>

{#snippet acciones(p: Paso, confirmar: string)}
	{#if p.estado !== 'hecho'}
		<div class="acciones">
			{#if p.manual}
				<form method="POST" action="?/confirmar" use:enhance>
					<input type="hidden" name="paso" value={p.id} />
					<button class="boton principal" type="submit">{confirmar}</button>
				</form>
			{/if}
			{#if p.omitible && p.estado === 'pendiente'}
				<form method="POST" action="?/omitir" use:enhance>
					<input type="hidden" name="paso" value={p.id} />
					<button class="boton" type="submit">Not now</button>
				</form>
			{/if}
		</div>
	{/if}
{/snippet}

<ol class="pasos">
	{#each data.pasos as p, i (p.id)}
		<li class="panel paso {p.estado}" class:siguiente={p.id === siguiente}>
			<header>
				<span class="marca-paso" aria-hidden="true">{p.estado === 'hecho' ? '✓' : i + 1}</span>
				<h2>{TITULOS[p.id]}</h2>
				<span class="estado-paso">{ESTADOS[p.estado]}</span>
			</header>

			<div class="cuerpo">
				{#if form?.error && form.paso === p.id}
					<p class="error" role="alert">{form.error}</p>
				{/if}

				{#if p.id === 'cuenta'}
					{#if h.cuentaLocal}
						<p>
							You sign in with your own password and a recovery email address. You can change both
							in <a href="/account">Account</a>, and add more people in <a href="/users">Users</a>.
						</p>
					{:else}
						<p>
							You sign in with your organization's account. There is no console password to keep.
						</p>
					{/if}
				{:else if p.id === 'acceso'}
					{#if h.acceso === 'restringida'}
						<p>Only the addresses in your list can open this console.</p>
					{:else if h.acceso === 'abierta'}
						<p>
							Anyone who reaches this machine can open the console, and see that it sits next to the
							honeypots. Limiting it to a list of addresses is recommended.
						</p>
					{:else}
						<p>Choose which IP addresses can open this console.</p>
					{/if}
					<p><a class="boton" href="/settings/access">Review console access</a></p>
				{:else if p.id === 'codigo'}
					{#if h.hayCodigo}
						<p>
							The installer showed an emergency code next to the first sign-in details. It is the
							way in when nobody can sign in, and the console never shows it again. Keep it outside
							this machine, for example in your password manager.
						</p>
						{#if p.estado !== 'hecho'}
							<p class="ayuda">
								If you no longer have it, <a href="/settings"
									>replace it with a new one in Settings</a
								> and save that one.
							</p>
						{/if}
						{@render acciones(p, 'I have saved it')}
					{:else}
						<p>
							This console has no emergency code. It is the way in when nobody can sign in.
							<a href="/settings">Create one in Settings</a> and keep it outside this machine.
						</p>
					{/if}
				{:else if p.id === 'empresa'}
					{#if h.dominio}
						<p>
							Company domain: <b class="mono">{h.dominio}</b>. New honeypots take names similar to
							those on your network. You can change it in <a href="/settings#dominio">Settings</a>.
						</p>
					{:else}
						<form class="dominio" method="POST" action="?/dominio" use:enhance>
							<label for="setup-dominio">
								What is your company's domain? Honeypots will use names similar to those on your
								network.
							</label>
							<div class="acciones">
								<input
									id="setup-dominio"
									name="dominio"
									required
									value={data.dominioSugerido}
									placeholder="company.com"
									autocomplete="off"
									spellcheck="false"
								/>
								<button class="boton principal" type="submit">Save</button>
							</div>
						</form>
						{@render acciones(p, '')}
					{/if}
					<p class="ayuda">
						Dates and times are shown in the <b>{data.zonaHoraria}</b> time zone. Each person can change
						theirs at the bottom of the menu.
					</p>
				{:else if p.id === 'registro'}
					{#if h.registrado}
						<p>
							This console is registered: it has the full free catalog and updates itself. Details
							in <a href="/settings#free-registration">Settings</a>.
						</p>
					{:else}
						<p>
							Register an email address, free of charge, to unlock the rest of the free honeypots
							and automatic updates. Without registration only the SSH honeypot is available.
						</p>
						<div class="acciones">
							<a class="boton principal" href="/settings#free-registration">Register</a>
						</div>
						{@render acciones(p, '')}
					{/if}
				{:else if p.id === 'avisos'}
					{#if h.hayAvisos}
						<p>
							Alerts are set up. Review where they are sent in <a href="/alerts">Alerts & SIEM</a>.
						</p>
					{:else}
						<p>
							Without an alert destination, events only appear in this console. Add email, Teams,
							Slack or your SIEM so someone is notified when a honeypot is touched.
						</p>
						<div class="acciones">
							<a class="boton principal" href="/alerts">Set up alerts</a>
						</div>
						{@render acciones(p, '')}
					{/if}
				{:else if p.id === 'certificado'}
					<p>
						The browser warns about this console until the computers that open it trust its
						certificate root. Download the root and install it on those computers as a trusted root
						certification authority.
					</p>
					<div class="acciones">
						<a class="boton" href="/ca-raiz.crt" download>Download the root</a>
						<a class="boton" href="/settings/certificate">Fingerprint and details</a>
					</div>
					{@render acciones(p, 'It is installed')}
				{:else if p.id === 'trampa'}
					<ul class="subpasos">
						<li class:hecho={h.hayTrampa}>
							<span class="marca-paso" aria-hidden="true">{h.hayTrampa ? '✓' : ''}</span>
							{#if h.hayTrampa}
								A honeypot is deployed.
							{:else}
								<span>Deploy a honeypot from the <a href="/decoys/catalog">catalog</a>.</span>
							{/if}
						</li>
						<li class:hecho={h.trampaProbada}>
							<span class="marca-paso" aria-hidden="true">{h.trampaProbada ? '✓' : ''}</span>
							{#if h.trampaProbada}
								It has been tested with a real event.
							{:else}
								<span>
									Touch it once, as an attacker would, and check that the event arrives. Each
									honeypot explains how in <a href="/decoys">Honeypots</a>.
								</span>
							{/if}
						</li>
					</ul>
					{@render acciones(p, '')}
				{/if}
			</div>
		</li>
	{/each}
</ol>

{#if !data.terminado}
	<section class="panel final">
		{#if form?.error && form.paso === 'final'}
			<p class="error" role="alert">{form.error}</p>
		{/if}
		{#if faltan === 0}
			<p>
				Nothing is pending. Skipped steps remain available from Settings and from this page's
				address.
			</p>
		{:else}
			<p>
				{faltan === 1 ? 'One step is' : `${faltan} steps are`} still pending. You can finish once none
				is.
			</p>
		{/if}
		<form method="POST" action="?/terminar">
			<button class="boton principal" type="submit" disabled={faltan > 0}>Finish setup</button>
		</form>
	</section>
{/if}

<style>
	.entrada {
		max-width: 70ch;
		margin: 0 0 16px;
		color: var(--ink-2);
	}

	.pasos {
		display: grid;
		gap: 12px;
		margin: 0 0 16px;
		padding: 0;
		list-style: none;
	}

	.paso header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 13px 17px;
	}

	.paso h2 {
		flex: 1;
		margin: 0;
		font-size: 15.5px;
	}

	.estado-paso {
		font-size: 12.5px;
		color: var(--ink-3);
	}

	.paso.pendiente .estado-paso {
		color: var(--warn);
	}

	.paso.siguiente {
		border-color: var(--line-strong);
	}

	.cuerpo {
		display: grid;
		gap: 10px;
		max-width: 76ch;
		padding: 0 17px 15px 47px;
		font-size: 14px;
	}

	.cuerpo p {
		margin: 0;
	}

	.paso.hecho .cuerpo,
	.paso.omitido .cuerpo {
		color: var(--ink-2);
	}

	.ayuda {
		font-size: 13px;
		color: var(--ink-3);
	}

	.acciones {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.dominio {
		display: grid;
		gap: 8px;
	}

	.dominio input {
		flex: 1;
		min-width: 0;
		max-width: 280px;
	}

	.marca-paso {
		display: grid;
		flex: none;
		place-items: center;
		width: 20px;
		height: 20px;
		border: 1px solid var(--line-strong);
		border-radius: 50%;
		font-size: 12px;
	}

	.hecho > header .marca-paso,
	.subpasos .hecho .marca-paso {
		border-color: var(--ok);
		background: color-mix(in oklab, var(--ok) 18%, var(--surface));
		color: var(--ok);
	}

	.subpasos {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.subpasos li {
		display: flex;
		align-items: flex-start;
		gap: 9px;
	}

	.final {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 17px;
	}

	.final p {
		margin: 0;
		font-size: 14px;
	}

	@media (max-width: 600px) {
		.cuerpo {
			padding-left: 17px;
		}
	}
</style>
