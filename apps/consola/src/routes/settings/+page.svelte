<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { sinVaciar } from '$lib/guardar';
	import { page } from '$app/state';
	import { sinLlavePorIp } from '$lib/llave-por-ip';
	import { nombreRol } from '$lib/permisos';
	import { fechaCorta, fechaHora, fechaLarga, horaCorta } from '$lib/fechas-pantalla';
	import { haceCuanto } from '$lib/formato';
	import EntraPropio from '$lib/components/EntraPropio.svelte';
	import OidcPropio from '$lib/components/OidcPropio.svelte';
	import SoporteAcceso from '$lib/components/SoporteAcceso.svelte';
	import MigrarEntra from '$lib/components/MigrarEntra.svelte';
	import MenuAjustes from '$lib/components/MenuAjustes.svelte';
	import { GRUPOS_AJUSTES, type GrupoAjustes } from '$lib/ajustes-menu';

	let { data, form } = $props();
	const c = $derived(data.canal);

	/* Tamaños en unidades legibles (base 1000, como los discos). */
	const tam = (n: number) =>
		n >= 1e9
			? (n / 1e9).toFixed(1) + ' GB'
			: n >= 1e6
				? (n / 1e6).toFixed(0) + ' MB'
				: n >= 1e3
					? (n / 1e3).toFixed(0) + ' KB'
					: n + ' B';
	const miles = (n: number) => n.toLocaleString('en-GB');
	const reg = $derived(data.registro);

	/*
	 * El menú de la página: cada bloque pertenece a un grupo y solo se ve el
	 * grupo elegido. El grupo va en la dirección (?tab=), así funciona sin
	 * JavaScript y aguanta una recarga. Los bloques ocultos siguen en la página
	 * (atributo hidden), de modo que ningún formulario pierde lo escrito.
	 */
	const GRUPOS = GRUPOS_AJUSTES;
	type Grupo = GrupoAjustes;
	const esGrupo = (x: string | null): x is Grupo => GRUPOS.some((g) => g.id === x);

	/* Los enlaces que llegan de otras páginas apuntan a un bloque (#central…). */
	const GRUPO_DEL_ANCLA: Record<string, Grupo> = {
		dominio: 'general',
		'perfil-bancario': 'general',
		soporte: 'recovery',
		'free-registration': 'general',
		actualizaciones: 'updates',
		'politica-actualizacion': 'updates',
		acceso: 'access',
		certificado: 'access',
		entra: 'access',
		oidc: 'access',
		'segundo-factor': 'access',
		'recuperacion-panel': 'recovery',
		central: 'central',
		latido: 'central'
	};
	let porAncla = $state<Grupo | null>(null);
	$effect(() => {
		void page.url.href;
		const ancla = location.hash.slice(1);
		porAncla = GRUPO_DEL_ANCLA[ancla] ?? null;
		/* El bloque estaba oculto cuando el navegador quiso ir a él. */
		if (porAncla) tick().then(() => document.getElementById(ancla)?.scrollIntoView());
	});

	const grupo = $derived.by((): Grupo => {
		const pedido = page.url.searchParams.get('tab');
		if (esGrupo(pedido)) return pedido;
		if (porAncla) return porAncla;
		return page.url.searchParams.has('entra') || page.url.searchParams.has('oidc')
			? 'access'
			: 'general';
	});
	const oculto = (g: Grupo) => grupo !== 'all' && grupo !== g;
</script>

<svelte:head>
	<title>Settings — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Settings</h1>
</div>

<MenuAjustes actual={grupo} />

{#if form?.mensaje}<p class="mensaje" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

<section class="panel bloque" id="acceso" hidden={oculto('access')}>
	<h2>Console access</h2>
	<p class="ayuda">
		{#if data.acceso.estado === 'restringida'}
			Only the addresses in your list can open this console{#if data.acceso.cortafuegosMal}, but
				this machine's firewall does not apply the list{/if}.
		{:else}
			Anyone who reaches this machine can see the console.
		{/if}
	</p>
	<a class="boton" href="/settings/access">Choose who can open the console</a>
</section>

<section class="panel bloque" id="certificado" hidden={oculto('access')}>
	<h2>Console certificate</h2>
	<p class="ayuda">
		{#if data.ca === 'pendiente' || data.ca === 'fallida'}
			A new root for the console certificate is waiting to be installed on your computers.
		{:else if data.ca === 'cambiando'}
			The console is switching to its new certificate root.
		{:else}
			The root your computers need to trust so the browser does not warn about this console.
		{/if}
	</p>
	<a class="boton" href="/settings/certificate">View the certificate root</a>
</section>

<section class="panel bloque" id="perfil-bancario" hidden={oculto('general')}>
	<h2>Banking profile</h2>
	<p class="ayuda">
		The settings a bank's change management and access control ask for, applied at once. Each one
		can still be changed on its own, and every change is recorded in the audit log.
	</p>
	<ul class="banca">
		<li>
			<span class="estado-banca {data.banca.politica ? 'bien' : 'mal'}"
				>{data.banca.politica ? 'On' : 'Off'}</span
			>
			<b>Updates:</b> an administrator approves each version, no earlier than 72 hours after it is
			published.
			<a href="?tab=updates#politica-actualizacion">Update policy</a>
		</li>
		<li>
			<span class="estado-banca {data.banca.soporte ? 'bien' : 'mal'}"
				>{data.banca.soporte ? 'On' : 'Off'}</span
			>
			<b>{data.operador} support:</b> just-in-time, each request approved separately for 4 hours at
			most, recorded and closed automatically.
			<a href="?tab=recovery#soporte">Support access</a>
		</li>
		<li>
			<span class="estado-banca {data.banca.separacion ? 'bien' : 'mal'}"
				>{data.banca.separacion ? 'On' : 'Off'}</span
			>
			<b>Credentials:</b> administrators cannot reveal captured credentials, even with the credential
			viewer role. Only people who hold that role without being administrators can.
		</li>
	</ul>
	<div class="acciones">
		{#if data.banca.completo}
			<p class="bien">In place.</p>
		{:else}
			<form method="POST" action="?/perfilBanca" use:enhance>
				<button class="boton principal">Apply the banking profile</button>
			</form>
		{/if}
		<form method="POST" action="?/separacionCredenciales" use:enhance>
			<input type="hidden" name="activa" value={data.banca.separacion ? 'no' : 'si'} />
			<button class="boton"
				>{data.banca.separacion
					? 'Let administrators reveal credentials'
					: 'Separate the credential role'}</button
			>
		</form>
	</div>
</section>

<section class="panel bloque" id="dominio" hidden={oculto('general')}>
	<h2>Your company domain</h2>
	<p class="ayuda">
		With it, new honeypots suggest names similar to those on your network instead of the factory
		defaults. You can change them on each honeypot.
	</p>
	<form method="POST" action="?/identidad" use:enhance class="dominio">
		<input
			name="dominio"
			required
			value={data.dominioSugerido}
			placeholder="company.com"
			autocomplete="off"
			spellcheck="false"
			aria-label="Your company domain"
		/>
		<button class="boton">Save</button>
	</form>
	{#if data.ejemplosDominio.length}
		<p class="ayuda">
			For example: {#each data.ejemplosDominio as e, i (e)}{i ? ', ' : ''}<code>{e}</code>{/each}.
		</p>
	{/if}
	{#if data.trampasDeFabrica.length}
		<form method="POST" action="?/aplicarIdentidad" use:enhance>
			<p class="ayuda">
				You can apply it to the honeypots you already have. They restart for a few seconds. Anything
				you changed by hand is left alone, and so are honeypots marked External, which do not
				advertise your company name.
			</p>
			<ul class="cambios">
				{#each data.trampasDeFabrica as t (t.nombre)}
					<li>
						<strong>{t.nombre}</strong>:
						{#each t.cambios as c, i (c.campo)}{i ? '; ' : ''}{c.campo}: {c.antes || '(empty)'} →
							<code>{c.despues}</code>{/each}
					</li>
				{/each}
			</ul>
			<button class="boton">Apply the domain to these honeypots</button>
		</form>
	{/if}
</section>

{#if reg}
	<section class="panel bloque" id="free-registration" hidden={oculto('general')}>
		<h2>Free registration</h2>
		{#if !reg.verificable}
			<p class="ayuda">
				Registration is not available on this node: it lacks the key to verify activation codes. The
				rest of Sugardaddy works normally.
			</p>
		{:else if reg.estado === 'vigente' && reg.caduca}
			<p>
				Registered with <strong>{reg.correo}</strong>. You have the registration honeypots and
				automatic updates. The license is valid until {fechaLarga(reg.caduca)} and renews itself.
				{#if reg.funcionaHasta && reg.funcionaHasta !== reg.caduca}If it cannot renew, decoys
					already deployed keep running until {fechaLarga(reg.funcionaHasta)}.{/if}
			</p>
			{#if reg.fallo}<p class="aviso">Last renewal: {reg.fallo}</p>{/if}
			<form method="POST" action="?/autoActualizar" use:enhance class="fila-registro">
				{#if data.autoActualizar.activo}
					<span>
						Automatic updates are enabled. When it checks for a new version, this console tells
						SeguridadSI which version it is running, and nothing else.
					</span>
					<button class="boton" type="submit">Disable</button>
				{:else}
					<input type="hidden" name="activar" value="on" />
					<span>Automatic updates are disabled.</span>
					<button class="boton" type="submit">Enable</button>
				{/if}
			</form>
		{:else}
			{#if reg.estado === 'caducada' && reg.caduca}
				<p class="aviso">
					Your registration expired on {fechaLarga(reg.caduca)}.
					{#if reg.funcionaHasta && Date.parse(reg.funcionaHasta) >= data.ahora}
						Registration honeypots already deployed keep running until {fechaLarga(
							reg.funcionaHasta
						)}, but you cannot deploy new ones or change them.
					{:else}
						The registration honeypots have stopped.
					{/if}
					The rest of the node is not affected. It renews itself if the node has internet access; otherwise,
					paste a new code.
				</p>
				{#if reg.fallo}<p class="ayuda">Last renewal: {reg.fallo}</p>{/if}
				<form method="POST" action="?/renovarRegistro" use:enhance>
					<button class="boton">Renew now</button>
				</form>
			{:else if reg.estado === 'invalida'}
				<p class="aviso">The saved license is not valid. Paste a new activation code.</p>
			{:else}
				<p class="ayuda">
					Register your email to get automatic updates and these honeypots at no cost: {reg.trampas.join(
						', '
					)}.
				</p>
			{/if}
			<form method="POST" action="?/pedirRegistro" use:enhance class="dominio">
				<input
					type="email"
					name="correo"
					required
					maxlength="254"
					value={form?.correoRegistro ?? reg.correo ?? ''}
					placeholder="you@company.com"
					autocomplete="email"
					aria-label="Your email"
				/>
				<button class="boton principal">Request code</button>
			</form>
			<p class="ayuda">
				Your email and the name and version of this node are sent to SeguridadSI. You will receive a
				link to confirm the email; once confirmed, you will get the activation code.
			</p>
			<form method="POST" action="?/activarRegistro" use:enhance class="codigo-registro">
				<label>
					Activation code

					<textarea
						name="codigo"
						rows="3"
						required
						class="mono"
						spellcheck="false"
						autocomplete="off"
						placeholder="SDR1.…"></textarea>
				</label>
				<button class="boton">Enable</button>
			</form>
		{/if}
	</section>
{/if}

<section class="panel bloque" id="actualizaciones" hidden={oculto('updates')}>
	<h2>Version and updates</h2>
	<p class="version-actual">
		You are on version <b class="mono">{data.version}</b>
		{#if data.actualizacion.estado === 'pendiente' && data.espera.motivo === 'aprobacion'}
			· <b class="mono aviso">{data.actualizacion.version}</b> is signed and verified, waiting for your
			approval
		{:else if data.actualizacion.estado === 'pendiente' && data.espera.motivo === 'retardo'}
			· <b class="mono aviso">{data.actualizacion.version}</b> is signed and verified, waiting for
			the minimum delay{#if data.espera.hasta}&nbsp;(until {fechaHora(data.espera.hasta)}){/if}
		{:else if data.actualizacion.estado === 'pendiente'}
			· <b class="mono aviso">{data.actualizacion.version}</b> is signed and verified, waiting for the
			updater
		{:else if data.actualizacion.estado === 'aplicando'}
			· installing <b class="mono aviso">{data.actualizacion.version}</b>
		{:else if data.actualizacion.estado === 'fallida'}
			· <b class="mal">{data.actualizacion.version} failed and was rolled back</b>
			{#if data.actualizacion.detalle}<span class="mono">{data.actualizacion.detalle}</span>{/if}
		{:else if data.disponible}
			· <b class="aviso">a new version is available: <span class="mono">{data.disponible}</span></b>
		{:else if data.gestionado || data.autoActualizar.activo || data.buscarActualizaciones}
			· up to date
		{/if}
		{#if c?.estado?.despliegueEnPausa}· rollout paused{/if}
	</p>

	{#if data.actualizacion.estado === 'pendiente' && data.politica.modo === 'manual'}
		<div class="aprobar-version">
			<p>
				Version <b class="mono">{data.actualizacion.version}</b>
				{#if data.pendienteFirmada?.publicada}was published {fechaHora(
						data.pendienteFirmada.publicada
					)}{/if}{#if data.pendienteFirmada?.urgente}
					and is <b class="aviso">marked as an urgent security fix</b>: it skips the minimum delay
					once approved{/if}.
			</p>
			{#if data.aprobacion}
				<p class="ayuda">
					Approved by {data.aprobacion.quien} on {fechaHora(data.aprobacion.cuando)}.
				</p>
			{:else}
				<form method="POST" action="?/aprobarActualizacion" use:enhance={sinVaciar}>
					<input type="hidden" name="version" value={data.actualizacion.version} />
					<button class="boton">Approve version {data.actualizacion.version}</button>
				</form>
			{/if}
		</div>
	{/if}

	{#if data.gestionado}
		<p class="ayuda">
			This node is enrolled in the {data.operador} Central: new versions arrive signed by it and are installed
			according to the update policy below.
		</p>
	{:else}
		<form method="POST" action="?/comprobarVersion" use:enhance={sinVaciar} class="fila-registro">
			<span>
				{#if !data.comprobada}
					This node has not checked for a new version yet.
				{:else if data.comprobada.rechazada}
					Last checked {fechaHora(data.comprobada.cuando)}:
					<b class="mal">the published version was not accepted</b>
					({data.comprobada.rechazada}).
				{:else if !data.comprobada.red}
					Last checked {fechaHora(data.comprobada.cuando)}:
					<b class="aviso">the update server could not be reached</b>.
				{:else}
					Last checked {fechaHora(data.comprobada.cuando)}{#if data.comprobada.version}: the
						published version is <b class="mono">{data.comprobada.version}</b>{/if}.
				{/if}
				It checks on start and every 6 hours.
			</span>
			<button class="boton">Check now</button>
		</form>
		<h3>Notify only</h3>
		<p>
			No automatic updates: the console periodically checks for a newer published version and
			notifies you at the top of the page. It installs nothing; you decide when to update.
		</p>
		<form method="POST" action="?/buscarActualizaciones" use:enhance={sinVaciar}>
			<label class="interruptor">
				<input type="checkbox" name="buscar" checked={data.buscarActualizaciones} />
				<span><b>Notify me of new versions</b></span>
			</label>
			<button class="boton" type="submit">Save</button>
		</form>
	{/if}
</section>

<section class="panel bloque" id="politica-actualizacion" hidden={oculto('updates')}>
	<h2>Update policy</h2>
	<p class="ayuda">
		When a signed version that has reached this node is installed. The updater on this machine
		enforces it, so neither this console nor the Central can install a version earlier than the
		policy allows. Every change and every approval is recorded in the audit log.
	</p>
	<p>
		Now: <b
			>{data.politica.modo === 'manual'
				? 'an administrator approves each version'
				: 'versions install automatically'}</b
		>{#if data.politica.retardoHoras > 0}, no earlier than <b>{data.politica.retardoHoras} hours</b>
			after they are published{/if}.
	</p>
	<form method="POST" action="?/politicaActualizacion" use:enhance={sinVaciar} class="politica">
		<fieldset>
			<legend>Installation</legend>
			<label class="opcion">
				<input
					type="radio"
					name="modo"
					value="automatica"
					checked={data.politica.modo === 'automatica'}
				/>
				<span><b>Automatic</b>: install as soon as the version arrives.</span>
			</label>
			<label class="opcion">
				<input type="radio" name="modo" value="manual" checked={data.politica.modo === 'manual'} />
				<span
					><b>Manual approval</b>: an administrator approves each version on this page before it is
					installed.</span
				>
			</label>
		</fieldset>
		<div class="plazo">
			<input
				id="retardo"
				name="retardo"
				type="number"
				inputmode="numeric"
				min="0"
				max="720"
				value={data.politica.retardoHoras}
			/>
			<label for="retardo">hours of minimum delay after a version is published (0 for none)</label>
		</div>
		<p class="ayuda">
			A version signed as an urgent security fix skips the delay, but still needs approval when
			approval is manual.
		</p>
		<div class="acciones">
			<button class="boton principal">Save</button>
			<button class="boton" name="preset" value="banca"
				>Use the banking profile (manual approval, 72 hours)</button
			>
		</div>
	</form>
</section>

<form class="panel bloque" method="POST" action="?/palabras" use:enhance hidden={oculto('events')}>
	<h2>Words that trigger an alert</h2>
	<p class="ayuda">
		If a password or username that was tried contains one of these words, the event becomes critical
		and is flagged as an alert. Only the exact word is matched (case and accents are ignored), with
		no variants: enter the one that truly identifies you, such as the company name. Minimum {data.minimoPalabra}
		letters. One per line.
	</p>
	<textarea name="palabras" rows="3" class="mono" spellcheck="false"
		>{form?.palabras ?? data.palabras.join('\n')}</textarea
	>
	<button class="boton">Save</button>
</form>

<form
	class="panel bloque"
	method="POST"
	action="?/conservacion"
	use:enhance
	hidden={oculto('events')}
>
	<h2>How long events are kept</h2>
	<p class="ayuda">
		Events and quarantined items older than this period are deleted automatically every hour and
		cannot be recovered. You are responsible for this data: set the period your privacy policy
		requires. Between {data.conservacion.minimo} and {data.conservacion.maximo} days; 365 is one year.
		The console audit logs are kept for one year, or for this period if it is longer.
	</p>
	{#if data.ahora < Date.parse(data.conservacion.aPartirDe)}
		<p class="ayuda">
			Deletions start on <b>{fechaCorta(data.conservacion.aPartirDe)}</b>: nothing is deleted until
			then, so you have time to change the period.
		</p>
	{/if}
	<div class="plazo">
		<input
			id="dias"
			name="dias"
			type="number"
			inputmode="numeric"
			min={data.conservacion.minimo}
			max={data.conservacion.maximo}
			value={form?.dias ?? data.conservacion.dias}
		/>
		<label for="dias">days</label>
	</div>
	<button class="boton">Save</button>
</form>

<section class="panel bloque" hidden={oculto('events')}>
	<h2>Event storage</h2>
	<p class="ayuda">
		How much space events take and how fast they grow. With the period above they do not grow
		forever: the oldest are deleted automatically, so the size levels off.
	</p>
	<dl class="espacio">
		<div>
			<dt>Events stored</dt>
			<dd>{miles(data.espacio.eventos)}</dd>
		</div>
		<div>
			<dt>Size</dt>
			<dd>
				{tam(data.espacio.eventosBytes)}
				<span class="sub">of {tam(data.espacio.baseBytes)} in total</span>
			</dd>
		</div>
		<div>
			<dt>Last month</dt>
			<dd>
				{miles(data.espacio.eventosMes)}
				<span class="sub">(~{miles(Math.round(data.estimacion.ritmoDia))}/day)</span>
			</dd>
		</div>
		{#if data.espacio.masViejo}
			<div>
				<dt>Oldest</dt>
				<dd>{haceCuanto(data.espacio.masViejo, data.ahora)}</dd>
			</div>
		{/if}
	</dl>
	{#if data.estimacion.fiable && data.estimacion.bytesPorEvento > 0}
		<p class="ayuda">
			At this rate, with a <b>{data.conservacion.dias}-day</b> period the database levels off at
			around <b>{tam(data.estimacion.bytesEnPlazo)}</b> (~{miles(data.estimacion.eventosEnPlazo)} events).
			It stops growing.
		</p>
	{:else}
		<p class="ayuda">There are too few events yet to estimate the size for this period.</p>
	{/if}
	<form
		method="POST"
		action="?/purgarEventos"
		use:enhance
		onsubmit={(e) => {
			if (
				!confirm(
					`Delete events older than ${data.conservacion.dias} days now? They cannot be recovered.`
				)
			)
				e.preventDefault();
		}}
	>
		<button class="boton">Purge now</button>
	</form>
	<p class="ayuda">
		"Purge now" applies the period immediately, without waiting for the hourly automatic deletion.
	</p>
</section>

{#if data.loginLocal}
	<section class="panel bloque" hidden={oculto('access')}>
		<h2>Local users</h2>
		<p class="ayuda">
			This node supports signing in with a username and password stored on the node itself. From
			here you add users, assign their roles, reset their passwords or remove them.
		</p>
		<a class="boton" href="/users">Manage users</a>
	</section>
{/if}

{#if data.segundoFactor}
	<section class="panel bloque" id="segundo-factor" hidden={oculto('access')}>
		<h2>Two-factor authentication</h2>
		<p class="ayuda">
			For local users: after the password, a passkey or a code from an authenticator app. Each user
			also gets ten single-use recovery codes. The emergency sign-in does not ask for it.
		</p>
		{#if data.segundoFactor.exigir}
			<p class="bien">Required.</p>
		{:else}
			<p class="mal">
				Optional: users without it sign in with their password alone{#if data.segundoFactor.por}
					(turned off by {data.segundoFactor.por}{#if data.segundoFactor.cuando}
						on {fechaCorta(data.segundoFactor.cuando)}{/if}){/if}.
			</p>
		{/if}
		{#if data.segundoFactor.sinFactor.length}
			<p class="ayuda">
				{data.segundoFactor.sinFactor.length === 1
					? 'One user has'
					: `${data.segundoFactor.sinFactor.length} users have`}
				not set it up yet{#if data.segundoFactor.exigir}; they will on their next sign-in{/if}:
				{data.segundoFactor.sinFactor.join(', ')}.
			</p>
		{/if}
		<form method="POST" action="?/segundoFactor" use:enhance>
			<input type="hidden" name="exigir" value={data.segundoFactor.exigir ? 'no' : 'si'} />
			<button class="boton {data.segundoFactor.exigir ? 'peligro' : ''}"
				>{data.segundoFactor.exigir ? 'Make it optional' : 'Require it'}</button
			>
		</form>
	</section>
{/if}

<div hidden={oculto('access')}>
	<EntraPropio {...data.entra} error={form?.entraError} valores={form?.entraValores} />
	<OidcPropio
		estado={data.oidc.estado}
		roles={data.oidc.roles}
		retorno={data.oidc.retorno}
		error={form?.oidcError}
		valores={form?.oidcValores}
	/>
	{#if data.entra.b2b === 'activo'}
		<MigrarEntra propio={data.entra.propio} equipo={data.equipoB2B} error={form?.migrarError} />
	{/if}
</div>

<section class="panel bloque" hidden={oculto('recovery')}>
	<h2>Emergency code</h2>
	<p class="ayuda">
		To sign in as an administrator if everything else is lost (password, email, Microsoft). It is
		used at <a href="/emergency">/emergency</a>, works once and is replaced by a new one when used.
		Store it away from this machine.
	</p>
	{#if form?.codigoEmergencia}
		<p class="codigo-nuevo" role="status">
			New code (the previous one is no longer valid). Copy it now: it will not be shown again.
			<code>{form.codigoEmergencia}</code>
		</p>
	{:else if data.codigoEmergencia}
		<p>
			Created by {data.codigoEmergencia.por} on
			{fechaCorta(data.codigoEmergencia.creado)}.
		</p>
	{:else}
		<p class="mal">This node has no emergency code.</p>
	{/if}
	<form
		method="POST"
		action="?/codigoEmergencia"
		use:enhance
		onsubmit={(e) => {
			if (data.codigoEmergencia && !confirm('The code you have saved will stop working. Continue?'))
				e.preventDefault();
		}}
	>
		<button class="boton"
			>{data.codigoEmergencia ? 'Replace it with a new one' : 'Create one'}</button
		>
	</form>
</section>

{#if data.gestionado}
	<section class="panel bloque" id="recuperacion-panel" hidden={oculto('recovery')}>
		<h2>Password recovery from Central</h2>
		<p class="ayuda">
			If you allow it, {data.operador} can send a recovery code for a local user from Central to your
			contact email. Leave it off unless you need it: if Central were compromised, it could be used to
			reset administrator passwords.
		</p>
		<form method="POST" action="?/recuperacionPanel" use:enhance>
			<input type="hidden" name="activa" value={data.recuperacionPanel ? 'no' : 'si'} />
			<p>{data.recuperacionPanel ? 'Allowed.' : 'Not allowed.'}</p>
			<button class="boton">{data.recuperacionPanel ? 'Do not allow it' : 'Allow it'}</button>
		</form>
	</section>
{/if}

<section class="panel bloque" hidden={oculto('recovery')}>
	<h2>Emergency keys</h2>
	<p class="ayuda">
		Another way to sign in as an administrator if everything else fails: a FIDO2 key. Have at least
		two and keep them in separate places.
	</p>
	{#if sinLlavePorIp(page.url.hostname)}<p class="mal">{sinLlavePorIp(page.url.hostname)}</p>{/if}
	{#if data.llaves.length === 0}
		<p>None registered.</p>
	{:else}
		<ul class="llaves">
			{#each data.llaves as l (l.id)}
				<li>
					<b>{l.nombre}</b>
					<small>
						registered by {l.registradaPor} on {fechaCorta(l.creada)}
						{#if l.ultimoUso}· last used {haceCuanto(l.ultimoUso, data.ahora)}{/if}
					</small>
					<form method="POST" action="?/retirarLlave" use:enhance>
						<input type="hidden" name="id" value={l.id} />
						<button class="boton peligro">Remove</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
	<a class="boton" href="/emergency/enroll">Register a key</a>
</section>

<div hidden={oculto('recovery')}>
	<SoporteAcceso
		soporte={data.soporte}
		operador={data.operador}
		modo={data.accesoModo}
		clientId={data.entra.propio?.activo ? data.entra.propio.clientId : null}
		consola={data.entra.retorno.replace(/\/auth\/callback$/, '/')}
		porCaducar={data.soportePorCaducar}
		postura={data.soportePostura}
		plazos={data.soportePlazos}
	/>
</div>

<section class="panel bloque" hidden={oculto('integrations')}>
	<h2>Event webhook</h2>
	<p>
		Sends every new event as-is (JSON) to a URL you own, so you can forward it to NATS, your SIEM or
		whatever you use. It is basic and <em>best-effort</em>: reliability is up to you. Plain
		<code>http://</code> is only allowed to private addresses on your network. (Managed, reliable alerts
		such as email, Teams and Sentinel are part of Sugardaddy Cloud.)
	</p>
	<form method="POST" action="?/webhook" use:enhance={sinVaciar}>
		<label for="wh-url">URL</label>
		<input
			id="wh-url"
			name="url"
			class="mono"
			value={data.webhook.url ?? ''}
			placeholder="https://your-endpoint.example/events"
		/>
		<label for="wh-secreto">
			Signing secret (optional){#if data.webhook.secretoPuesto}
				— <em
					>one is set{data.webhook.secretoFinal ? ` (ends in ${data.webhook.secretoFinal})` : ''};
					leave empty to keep it</em
				>{/if}
		</label>
		<input
			id="wh-secreto"
			name="secreto"
			class="mono"
			type="password"
			autocomplete="off"
			placeholder={data.webhook.secretoPuesto
				? '(unchanged)'
				: 'HMAC-SHA256 signature in the X-Sugardaddy-Firma header'}
		/>
		<label>
			<input type="checkbox" name="activo" checked={data.webhook.activo} />
			Active
		</label>
		{#if data.webhook.fallo}
			<p class="error">
				The last delivery failed ({fechaHora(data.webhook.fallo.cuando)}): {data.webhook.fallo
					.detalle}. Events wait and are retried.
			</p>
		{/if}
		<button class="boton principal" type="submit">Save</button>
	</form>
</section>

<section class="panel bloque" id="central" hidden={oculto('central')}>
	<h2>{data.operador} Central</h2>

	{#if !c}
		<p class="ayuda">
			This node works standalone. If you enroll it, it will send a heartbeat every minute with its
			version and its figures (never events or secrets, and your incidents only if you choose to
			share them) and will receive updates signed by {data.operador}. Ask {data.operador} for an enrollment
			code.
		</p>
		<form method="POST" action="?/alta" use:enhance>
			<label for="panel">Central address</label>
			<input
				id="panel"
				name="panel"
				class="mono"
				required
				placeholder="https://central.sugardaddy…"
				value={form?.panel ?? ''}
			/>
			<label for="codigo">Enrollment code</label>
			<input id="codigo" name="codigo" class="mono" required autocomplete="off" />
			<button class="boton principal">Enroll</button>
		</form>
	{:else}
		<dl>
			<dt>Status</dt>
			<dd>
				{#if c.cortado}
					<b class="mal">Cut by this customer</b>
				{:else if c.error}
					<b class="mal">Offline</b> <span class="mono">{c.error}</span>
				{:else}
					<b class="bien">Connected</b>
				{/if}
			</dd>
			<dt>Central</dt>
			<dd class="mono">{c.panel}</dd>
			<dt>Node · customer</dt>
			<dd class="mono">{c.nodo} · {c.cliente}</dd>
			<dt>Last contact</dt>
			<dd>{c.ultimoContacto ? haceCuanto(c.ultimoContacto, data.ahora) : 'never'}</dd>
			<dt>Central fingerprint</dt>
			<dd
				class="mono"
				title="Pinned at enrollment. A state signed with a different key is rejected. Only a version signed by SeguridadSI can add or replace Central keys."
			>
				{c.huellaPanel}
				{#each c.huellasPanel.filter((h) => h !== c.huellaPanel) as h (h)}
					· {h}
				{/each}
			</dd>
			<dt>This node's fingerprint</dt>
			<dd class="mono">{c.huellaNodo}</dd>
			{#if data.licenciaCloud}
				{@const l = data.licenciaCloud}
				<dt>Cloud license</dt>
				<dd>
					{#if !l.funciona}
						<b class="mal">Expired on {fechaLarga(l.caduca)}</b>. Paid decoys stopped on {fechaLarga(
							l.funcionaHasta
						)}.
					{:else if l.caducada}
						<b class="aviso">Expired on {fechaLarga(l.caduca)}</b>: paid decoys cannot be deployed
						or changed. Decoys keep running until {fechaLarga(l.funcionaHasta)}.
					{:else}
						Valid until {fechaLarga(l.caduca)} for deploying and changing paid decoys. Decoys keep running
						until {fechaLarga(l.funcionaHasta)}.
					{/if}
				</dd>
			{/if}
			{#if c.estado}
				<dt>Configuration</dt>
				<dd>
					{#if !data.configuracion}
						the one from the installation (it will update with the next version)
					{:else if data.configuracion.estado === 'aplicada'}
						the signed one from <span class="mono">{data.configuracion.version}</span>, applied
					{:else if data.configuracion.estado === 'aplicando'}
						<b class="aviso">applying the one from {data.configuracion.version}</b>
					{:else}
						<b class="mal"
							>the one from {data.configuracion.version} was not healthy and the previous one was restored</b
						>
						{#if data.configuracion.detalle}<span class="mono">{data.configuracion.detalle}</span
							>{/if}
					{/if}
					{#if data.relevo}
						<br /><b class="aviso"
							>sensor {data.relevo.sensor} has been switching {data.relevo.remoto
								? 'its machine'
								: 'the node'} to the signed configuration since {horaCorta(data.relevo.desde)}; {data
								.relevo.remoto
								? 'that sensor'
								: 'the node'} receives no new versions until it finishes (30 minutes at most)</b
						>
					{/if}
				</dd>
				<dt>Ring</dt>
				<dd>{c.estado.anillo}</dd>
			{/if}
		</dl>

		<div class="acciones">
			{#if c.cortado}
				<form method="POST" action="?/reanudar" use:enhance>
					<button class="boton principal">Resume the channel</button>
				</form>
			{:else}
				<form method="POST" action="?/latir" use:enhance>
					<button class="boton">Send heartbeat now</button>
				</form>
				<form method="POST" action="?/cortar" use:enhance>
					<button class="boton peligro">Cut the channel with {data.operador}</button>
				</form>
			{/if}
		</div>
		<p class="ayuda">
			Cutting the channel switches nothing off: honeypots keep detecting and responses keep working
			here. It only stops information reaching Central and stops accepting what it sends. It also
			closes support access and deletes your incidents from Central, if you were sharing them.
		</p>
	{/if}
</section>

<section class="panel bloque" id="latido" hidden={oculto('central')}>
	<h2>What the heartbeat sends</h2>
	<p class="ayuda">
		The heartbeat never carries events, IP addresses, credentials or secrets. By default it also
		sends counts (sensors, decoys, events in the last 24 hours) and diagnostics, so {data.operador}
		can see a node or a decoy that has stopped without asking you.
		{#if !c}This node must be enrolled in Central (above) for this to take effect.{/if}
	</p>
	<form method="POST" action="?/latidoMinimo" use:enhance={sinVaciar}>
		<label class="interruptor">
			<input type="checkbox" name="minimo" checked={data.latidoMinimo} />
			<span>
				<b>Minimal heartbeat</b>
				<small
					>Only what licensing and updates need: version, update status, sharing and support
					choices. No counts, sign-in method, audit seal, isolation or network diagnostics.</small
				>
			</span>
		</label>
		<button class="boton">Save</button>
	</form>
</section>

<section class="panel bloque" hidden={oculto('central')}>
	<h2>Share with other customers</h2>
	<p class="ayuda">
		Shared intelligence through the {data.operador} Central: what attacks you alerts the others, and the
		other way around.
		{#if !c}This node must be enrolled in Central (above) for this to take effect.{/if}
	</p>
	<form method="POST" action="?/comparticion" use:enhance={sinVaciar}>
		<label class="interruptor">
			<input type="checkbox" name="compartir" checked={data.comparticion.compartir} />
			<span>
				<b>Share my indicators</b>
				<small
					>Public IPs with a complete session only. Never internal IPs, usernames or your name.</small
				>
			</span>
		</label>
		<label class="interruptor">
			<input type="checkbox" name="recibir" checked={data.comparticion.recibir} />
			<span>
				<b>Receive the global list</b>
				<small>Indicators seen by several customers or approved by {data.operador}.</small>
			</span>
		</label>
		<button class="boton">Save</button>
	</form>
</section>

<style>
	.cabecera {
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.mensaje,
	.error {
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
	}

	.mensaje {
		background: var(--accent-soft);
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}

	.bloque[hidden] {
		display: none;
	}

	.bloque {
		margin-bottom: 16px;
		padding: 18px 20px 20px;
		max-width: 760px;
	}

	.bloque h2 {
		font-size: 16px;
		font-weight: 600;
	}

	.fila-registro {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}

	.codigo-registro {
		display: grid;
		gap: 10px;
		justify-items: start;
	}

	.codigo-registro label,
	.codigo-registro textarea {
		width: 100%;
	}

	.interruptor {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin: 14px 0;
		font-weight: 400;
		color: var(--ink);
	}

	.interruptor input {
		width: auto;
		margin-top: 3px;
		accent-color: var(--link);
	}

	.interruptor span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.interruptor b {
		font-size: 13.5px;
	}

	.interruptor small {
		font-size: 12px;
		color: var(--ink-3);
	}

	.version-actual {
		font-size: 14px;
	}

	.aprobar-version {
		margin: 0.75rem 0;
		padding: 0.75rem 1rem;
		border-left: 3px solid var(--warn);
	}
	.politica fieldset {
		border: 0;
		padding: 0;
		margin: 0 0 0.75rem;
	}
	.politica .opcion {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		margin: 0.25rem 0;
	}
	.politica .acciones {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	#actualizaciones h3 {
		margin: 18px 0 4px;
		font-size: 14px;
	}

	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 8px 0 4px;
	}

	.bloque form .boton {
		margin-top: 16px;
	}

	.espacio {
		margin: 4px 0 6px;
		/* Una fila por dato. Explícito porque los dl heredan 2 columnas del estilo global. */
		display: grid;
		grid-template-columns: 1fr;
		gap: 0;
	}

	.espacio div {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		font-size: 14px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
	}

	.espacio dt {
		color: var(--ink-3);
		margin: 0;
		white-space: nowrap;
	}

	.espacio dd {
		margin: 0;
		font-weight: 600;
		text-align: right;
	}

	.espacio dd .sub {
		white-space: nowrap;
	}

	.sub {
		color: var(--ink-3);
		font-weight: 400;
		font-size: 12.5px;
	}

	.plazo {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 12px 0;
	}

	.plazo input {
		width: 8em;
	}

	.codigo-nuevo code {
		display: block;
		width: fit-content;
		margin-top: 8px;
		padding: 10px 14px;
		font-size: 16px;
		letter-spacing: 0.06em;
		background: var(--surface-2);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		user-select: all;
	}

	.llaves {
		list-style: none;
		margin: 10px 0 14px;
		padding: 0;
	}

	.llaves li {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 12px;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	.llaves small {
		color: var(--ink-3);
	}

	dl {
		display: grid;
		grid-template-columns: 160px 1fr;
		gap: 8px 16px;
		margin: 14px 0 0;
		font-size: 13.5px;
	}

	dt {
		color: var(--ink-3);
	}

	dd {
		margin: 0;
		word-break: break-all;
	}

	.bien {
		color: var(--ok);
	}

	.mal {
		color: var(--crit);
	}

	.aviso {
		color: var(--warn);
	}

	.acciones {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 18px;
	}

	.banca {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
		display: grid;
		gap: 8px;
		font-size: 13.5px;
	}

	.estado-banca {
		display: inline-block;
		min-width: 34px;
		font-weight: 600;
		font-size: 12px;
		text-transform: uppercase;
	}

	textarea {
		width: 100%;
		resize: vertical;
		margin-bottom: 10px;
	}

	form.dominio {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 8px 0;
	}

	form.dominio input {
		flex: 0 1 280px;
	}

	ul.cambios {
		margin: 6px 0 10px;
		padding-left: 18px;
		font-size: 13px;
		line-height: 1.6;
	}
</style>
