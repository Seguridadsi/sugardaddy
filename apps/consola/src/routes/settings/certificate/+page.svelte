<script lang="ts">
	import { page } from '$app/state';
	import { fechaHora } from '$lib/fechas-pantalla';

	let { data, form } = $props();
	/* El último cambio falló con la raíz que se enseña ahora: se dice y se puede volver a confirmar. */
	const fallo = $derived(
		data.resultado?.estado === 'fallida' &&
			!!data.nueva &&
			data.resultado.huella === data.nueva.huella &&
			!data.aprobada
			? data.resultado
			: null
	);
	const hecho = $derived(
		data.modo === 'propia' && data.resultado?.estado === 'aplicada' ? data.resultado : null
	);
</script>

<svelte:head>
	<title>Console certificate — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Console certificate</h1>
</div>

{#if page.url.searchParams.has('confirmada')}
	<p class="mensaje" role="status">
		Confirmed. The node switches to the new root within a minute or two. While it does, this page
		may lose its connection for a few seconds: reload it.
	</p>
{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

{#if data.ficheros}
	<section class="panel bloque">
		<h2>Certificate from your organization</h2>
		<p class="ayuda">
			This console uses a certificate issued by your organization's CA. There is no node root to
			install on the computers.
		</p>
	</section>
{:else}
	<section class="panel bloque">
		<h2>Root in use</h2>
		{#if data.activa}
			<p class="ayuda">
				The computers that open this console need to trust this root so the browser does not warn.
				Install it as a <strong>trusted root certification authority</strong>.
			</p>
			<dl class="huella">
				<dt>Name</dt>
				<dd>{data.activa.nombre}</dd>
				<dt>SHA-256 fingerprint</dt>
				<dd><code>{data.activa.huella}</code></dd>
			</dl>
			<p><a class="boton" href="/ca-raiz.crt" download>Download the root in use</a></p>
			{#if data.modo === 'propia'}
				<p class="estado bien">
					It only works for {data.direccion ?? 'this console'}, and only for websites.
				</p>
				<p class="ayuda">
					If someone took over this machine, which sits next to the honeypots and is meant to
					attract attackers, this root would only let them pretend to be this console: not your
					other websites, your software updates or your email. A name also covers the names below it
					(<code>x.{data.direccion}</code>), so do not use names under the console's for anything
					else.
				</p>
			{:else if data.modo === 'caddy'}
				<p class="estado mal">This root can be used for any website.</p>
				<p class="ayuda">
					Its key lives on this machine, which sits next to the honeypots and is meant to attract
					attackers. Whoever took it could impersonate any website to the computers that trust it.
					Replace it with the new root below.
				</p>
			{/if}
		{:else}
			<p class="ayuda">
				The root is not ready yet. It appears a few minutes after the node starts; if it does not,
				check that the node updater is running.
			</p>
		{/if}
		{#if data.error}
			<p class="aviso">The node reports a problem with its certificate authority: {data.error}</p>
		{/if}
	</section>

	{#if hecho}
		<section class="panel bloque">
			<h2>Switched to the new root</h2>
			<p class="ayuda">
				On {fechaHora(hecho.cuando)}. {hecho.detalle.charAt(0).toUpperCase() +
					hecho.detalle.slice(1)}.
			</p>
			{#if hecho.ilegibles.length}
				<p class="aviso">
					Delete these backups by hand: they could not be read with this node's backup key and may
					hold the previous key: {#each hecho.ilegibles as b, i (b)}{i ? ', ' : ''}<code>{b}</code
						>{/each}.
				</p>
			{/if}
			<p class="ayuda">
				Now remove the previous root from the computers. Its key no longer exists on this machine,
				but a copy taken earlier could. Backups you copied off this machine before the switch still
				hold it: delete them, or make new ones.
			</p>
			{#if data.anterior}
				<dl class="huella">
					<dt>Previous root</dt>
					<dd>{data.anterior.nombre}</dd>
					<dt>SHA-256 fingerprint</dt>
					<dd><code>{data.anterior.huella}</code></dd>
				</dl>
			{/if}
		</section>
	{/if}

	{#if data.nueva}
		<section class="panel bloque">
			<h2>Replace the root</h2>
			{#if data.aprobada}
				<p class="estado">
					Switching: confirmed by {data.aprobada.quien} on {fechaHora(data.aprobada.cuando)}.
				</p>
				<p class="ayuda">
					It usually takes a minute or two. If this message stays for longer, the node updater is
					not running: nothing changes until it does.
				</p>
			{:else}
				{#if fallo}
					<p class="aviso">
						The last attempt failed on {fechaHora(fallo.cuando)}, and the node went back to the root
						in use: nothing changed on the computers.
					</p>
					<pre class="detalle"><code>{fallo.detalle}</code></pre>
				{/if}
				<p class="ayuda">
					The node has a new root of its own. It only works for <strong
						>{data.direccion ?? 'this console'}</strong
					>, and only for websites: it cannot sign software, email or any other website. Until you
					confirm below, nothing changes and nobody sees a warning.
				</p>

				<h3>1. Download the new root</h3>
				<dl class="huella">
					<dt>Name</dt>
					<dd>{data.nueva.nombre}</dd>
					<dt>SHA-256 fingerprint</dt>
					<dd><code>{data.nueva.huella}</code></dd>
				</dl>
				<p>
					<a class="boton" href="/settings/certificate/new-root.crt" download
						>Download the new root</a
					>
				</p>
				<p class="ayuda">When you install it, check that the fingerprint is this one.</p>

				<h3>2. Install it on every computer that opens the console</h3>
				<p class="ayuda">
					Next to the root in use, as a trusted root certification authority. Both can live side by
					side: the browser keeps working with the current one until the switch.
				</p>
				<ul class="pasos">
					<li>
						<strong>Windows, many computers (Group Policy):</strong> in Group Policy Management,
						edit a policy linked to those computers and go to Computer Configuration → Policies →
						Windows Settings → Security Settings → Public Key Policies → Trusted Root Certification
						Authorities. Right-click it, choose Import and select the file. The computers pick it up
						at their next policy refresh (<code>gpupdate /force</code> does it now).
					</li>
					<li>
						<strong>Windows, one computer:</strong> in a command prompt run as administrator,
						<code>certutil -addstore -f Root sugardaddy-console-root.crt</code>.
					</li>
					<li>
						<strong>macOS:</strong>
						<code
							>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain
							sugardaddy-console-root.crt</code
						>, or open the file, add it to the System keychain and set it to Always Trust.
					</li>
					<li>
						<strong>Linux (Debian, Ubuntu):</strong> copy it to
						<code>/usr/local/share/ca-certificates/</code> and run
						<code>sudo update-ca-certificates</code>.
					</li>
					<li>
						<strong>Firefox</strong> keeps its own list unless it is set to use the system's: import
						it under Settings → Privacy &amp; Security → Certificates → View Certificates →
						Authorities, or use the <code>Certificates</code> enterprise policy.
					</li>
				</ul>

				{#if data.sensores.length}
					<h3>Remote sensors</h3>
					<p class="aviso">
						These remote sensors do not trust the new root yet. Sensors that are running pick it up
						within a minute or two; one that stays here is probably switched off, or on an older
						version:
						{#each data.sensores as x, i (x.id)}{i ? ', ' : ''}<strong>{x.nombre}</strong
							>{#if x.ultimoLatido}
								(last seen {fechaHora(x.ultimoLatido)}){/if}{/each}. If you switch without them,
						they will need a new install line from Sensors.
					</p>
				{/if}

				<h3>3. Confirm</h3>
				<p class="ayuda">
					When you confirm, the node switches to the new root. Computers without it will not be able
					to open the console, not even by accepting the browser warning, because the console tells
					browsers to always require a valid certificate (HSTS). Then the key of the root in use is
					destroyed on this machine and in its backups.
				</p>
				<form method="POST" action="?/confirmar">
					<input type="hidden" name="huella" value={data.nueva.huella} />
					<label class="confirmar">
						<input type="checkbox" name="instalada" value="si" required />
						The new root is installed on the computers that open this console.
					</label>
					{#if data.sensores.length}
						<label class="confirmar">
							<input type="checkbox" name="cortarSensores" value="si" />
							Switch without the remote sensors listed above: they will lose contact with the console
							until they are installed again.
						</label>
					{/if}
					<button class="boton principal">It's on the computers: switch to the new root</button>
				</form>
			{/if}
		</section>
	{/if}
{/if}

<style>
	.estado {
		font-weight: 600;
	}
	.estado.bien {
		color: var(--ok);
	}
	.estado.mal {
		color: var(--crit);
	}
	.huella {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 1rem;
		margin: 0.75rem 0;
	}
	.huella dt {
		opacity: 0.7;
	}
	.huella dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	code {
		overflow-wrap: anywhere;
	}
	.pasos li {
		margin-bottom: 0.5rem;
	}
	.detalle {
		white-space: pre-wrap;
		max-height: 12rem;
		overflow: auto;
	}
	.confirmar {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		margin-bottom: 0.75rem;
	}
	h3 {
		margin-top: 1.25rem;
	}
	@media (max-width: 640px) {
		.huella {
			grid-template-columns: 1fr;
		}
	}
</style>
