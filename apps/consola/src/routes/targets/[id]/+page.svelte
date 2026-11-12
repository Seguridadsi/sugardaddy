<script lang="ts">
	import AlcancePorSalida from '$lib/components/AlcancePorSalida.svelte';
	import Pestanas from '$lib/components/Pestanas.svelte';
	import { pestanaDe } from '$lib/pestanas';
	import CopiarTexto from '$lib/components/CopiarTexto.svelte';
	import DireccionesSensor from '$lib/components/DireccionesSensor.svelte';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import EstadoTrampa from '$lib/components/EstadoTrampa.svelte';
	import FormularioDestino from '$lib/components/FormularioDestino.svelte';
	import { nombreFuente, nombreTipoDestino } from '$lib/destinos';
	import { enFrase, haceCuanto } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();

	/* Lo que hay en la máquina, sus ajustes y por dónde avisa: cada cosa en su pestaña. */
	const PESTANAS = $derived([
		{ id: 'overview', texto: 'Overview' },
		/* Los puertos de sus honeypots y quién los abre: solo donde hay sensor. */
		...(data.destino.sensor ? [{ id: 'firewall', texto: 'Firewall' }] : []),
		{ id: 'settings', texto: 'Settings' },
		...(data.alcance ? [{ id: 'alerts', texto: 'Alerts' }] : [])
	]);
	const pestana = $derived(pestanaDe(page.url, PESTANAS) as string);
	const d = $derived(data.destino);
	const roles = $derived(page.data.usuario?.roles ?? []);
	const opera = $derived(puede(roles, 'desplegar'));
	const admin = $derived(puede(roles, 'ajustes'));
	const valen = $derived(d.queCabe.filter((m) => m.elegida).length);
	const nube = $derived(data.cortafuegos);
	/* Del id de recurso del NSG, lo que una persona reconoce: su grupo de recursos y su nombre. */
	const partesNsg = $derived.by(() => {
		const m = /\/resourceGroups\/([^/]+)\/.*\/networkSecurityGroups\/([^/]+)$/i.exec(
			nube?.nsg ?? ''
		);
		return m ? { grupo: m[1], nombre: m[2] } : null;
	});
	let abriendo = $state<'simular' | 'abrir' | null>(null);
	const resultado = $derived(
		form?.accion === 'abrir' && 'resultado' in form ? form.resultado : null
	);
	/* Lo que se dice de cada regla: en «Preview», lo que se haría; después, lo hecho. */
	const QUE_HARIA = {
		crear: 'Would be created',
		cambiar: 'Would be updated',
		quitar: 'Would be removed',
		igual: 'No change needed'
	};
	const QUE_HIZO = {
		crear: 'Created',
		cambiar: 'Updated',
		quitar: 'Removed',
		igual: 'Already in place'
	};
	/* Lo guardado, o lo que se acaba de escribir si no se pudo guardar. */
	const valores = $derived(
		form?.accion === 'editar' && form.valores
			? form.valores
			: { nombre: d.nombre, ...d.descripcion }
	);
</script>

<svelte:head>
	<title>{d.nombre} — Sugardaddy</title>
</svelte:head>

<a class="volver" href={resolve('/sensors')}>← Sensors</a>

<div class="cabecera">
	<p class="eyebrow">{nombreTipoDestino(d.tipo)} · <span class="mono">{d.id}</span></p>
	<h1>{d.nombre}</h1>
	<p class="linea">
		{d.plataforma ?? 'No system data'}
		·
		{#if d.sensor}
			sensor <a href={resolve('/sensors')}>{d.sensor.nombre}</a>,
			<span class="estado" class:mal={!d.sensor.vivo}
				>{d.sensor.vivo
					? 'online'
					: d.sensor.ultimoLatido
						? `offline ${haceCuanto(d.sensor.ultimoLatido, data.ahora)}`
						: 'never connected'}</span
			>
		{:else}
			no sensor
		{/if}
	</p>
	{#if d.ips.length || d.ipPublica}
		<div class="direcciones"><DireccionesSensor ips={d.ips} ipPublica={d.ipPublica} /></div>
	{/if}
	{#if d.descripcion.nota}<p class="nota-destino">{d.descripcion.nota}</p>{/if}
</div>

{#if data.creado}
	<p class="ok" role="status">Target added. Below you can see what can be deployed on it.</p>
{/if}
{#if form?.linea}
	<section class="panel token" role="status">
		<h2>Install line for <span class="mono">{form.para}</span></h2>
		<p>
			Paste it on the Ubuntu of this machine (or on an Ubuntu virtual machine inside it, with
			bridged networking). It works once, for 24 hours, and is only shown now: copy it before you
			leave or reload this page. It must be able to reach this console on port 443.
		</p>
		{#if form.fija}
			<p>
				The line and the installer tell that machine that
				<span class="mono">{form.consola ?? 'this console'}</span> is at
				<span class="mono">{form.fija}</span>: there is nothing to configure on it by hand.
			</p>
		{:else}
			<p>
				It must also resolve the name of this console{form.consola ? ', ' : ''}<span class="mono"
					>{form.consola ?? ''}</span
				>. If it cannot (a machine outside your network), generate the line again from Sensors with
				"Address of this console as seen from that machine" filled in.
			</p>
		{/if}
		<p class="mono valor">{form.linea}</p>
		<p><CopiarTexto texto={form.linea} etiqueta="Copy the line" /></p>
	</section>
{/if}

{#if d.avisos.length}
	<!-- Lo que cuenta el sensor de su máquina: los mismos avisos que en Sensores. -->
	<section class="panel avisos" aria-label="Sensor warnings">
		<ul>
			{#each d.avisos as a (a.codigo)}
				<li class:grave={a.gravedad === 'error'}>
					<p>
						<b>{a.titulo}</b>
						<small class="mono" title="Support code">{a.codigo}</small>
					</p>
					<p>{a.texto}</p>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Target sections" />

{#if form?.accion === 'alcance' && form.mensaje}<p class="ok" role="status">{form.mensaje}</p>{/if}
{#if data.alcance}
	<div hidden={pestana !== 'alerts'}>
		<AlcancePorSalida filas={data.alcance} que="this sensor" puede={opera} />
	</div>
{/if}

{#if d.sensor}
	<div class="cortafuegos" hidden={pestana !== 'firewall'}>
		<section class="panel bloque" id="firewall">
			<h2>Ports to open in the firewall</h2>
			{#if d.abrir.length}
				<p class="ayuda">
					Allow inbound traffic to these ports on this machine's firewall and on your cloud's, if it
					has one. Where a honeypot has its own address, open its ports only for that address, so
					each address shows a different machine.
				</p>
				<table class="abrir">
					<thead>
						<tr><th>Address</th><th>Port</th><th>Honeypot</th></tr>
					</thead>
					<tbody>
						{#each d.abrir as g (g.direccion ?? '')}
							{#each g.puertos as p, i (p.puerto + p.protocolo)}
								<tr>
									<td class="mono"
										>{#if i === 0}{g.direccion ?? 'All addresses of the machine'}{/if}</td
									>
									<td class="mono">{p.puerto}/{p.protocolo}</td>
									<td>{p.trampa}</td>
								</tr>
							{/each}
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="ayuda">No honeypot on this machine publishes a port yet.</p>
			{/if}
		</section>

		{#if nube}
			<section class="panel bloque">
				<h2>Open them in Azure</h2>
				{#if !nube.conector}
					<p class="ayuda">
						If this machine is behind an Azure network security group, the console can open these
						ports in it for you. It uses the Entra application of the response "IP block in Azure",
						which is not set up on this console yet.
					</p>
					<p class="ayuda">
						{#if admin}<a href={nube.enlaceConector}>Set up the Azure connector</a>.{:else}An
							administrator sets it up under Response.{/if} Until then, open the ports above by hand.
					</p>
				{:else}
					<p class="ayuda">
						The console writes one rule per honeypot and protocol, named
						<span class="mono">trampa-…</span>, from priority 200: inbound from the Internet to the
						honeypot's own address and ports. It removes the
						<span class="mono">trampa-…</span> rules of honeypots that are gone and never touches
						any other rule. The application of the
						<a href={nube.enlaceConector}>Azure connector</a> needs the Network Contributor role on this
						group.
					</p>
					{#if form?.accion === 'cortafuegos' && 'error' in form && form.error}
						<p class="errores" role="alert">{form.error}</p>
					{:else if form?.accion === 'cortafuegos' && 'mensaje' in form}
						<p class="hecho" role="status">{form.mensaje}</p>
					{/if}
					{#if admin}
						<form method="POST" action="?/cortafuegos&tab=firewall" use:enhance>
							<label for="nsg">Network security group (resource ID)</label>
							<input
								id="nsg"
								name="nsg"
								class="mono"
								placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Network/networkSecurityGroups/…"
								value={form?.accion === 'cortafuegos' && 'nsg' in form
									? form.nsg
									: (nube.nsg ?? '')}
							/>
							<p class="ayuda">
								{#if partesNsg}Resource group <b>{partesNsg.grupo}</b>, security group
									<b>{partesNsg.nombre}</b>.
								{/if}
								In the Azure portal: the security group → Properties → Resource ID. Sensors behind the
								same group share it: their honeypots are opened together.
							</p>
							<button class="boton enviar">Save</button>
						</form>
					{:else if partesNsg}
						<p class="ayuda">
							Resource group <b>{partesNsg.grupo}</b>, security group <b>{partesNsg.nombre}</b>.
						</p>
					{:else}
						<p class="ayuda">
							An administrator has not entered the security group of this sensor yet.
						</p>
					{/if}

					{#if admin && nube.nsg}
						<form
							class="abrir-nube"
							method="POST"
							action="?/abrir&tab=firewall"
							use:enhance={({ submitter }) => {
								abriendo = submitter?.getAttribute('value') === 'si' ? 'simular' : 'abrir';
								return async ({ update }) => {
									await update({ reset: false });
									abriendo = null;
								};
							}}
						>
							<button class="boton" name="simular" value="si" disabled={!!abriendo}
								>{abriendo === 'simular' ? 'Reading the group…' : 'Preview'}</button
							>
							<button class="boton principal" disabled={!!abriendo}
								>{abriendo === 'abrir'
									? 'Opening… this can take a minute'
									: 'Open these ports in Azure'}</button
							>
						</form>
					{/if}
					{#if form?.accion === 'abrir' && 'error' in form && form.error}
						<p class="errores" role="alert">{form.error}</p>
					{/if}
					{#if resultado}
						{@const fallos = resultado.pasos.filter((p) => !p.ok).length}
						<p class={fallos ? 'errores' : 'hecho'} role="status">
							{#if resultado.simulado}
								Preview only: nothing has been changed in Azure.
							{:else if fallos}
								{fallos} of {resultado.pasos.length} rules could not be written. The rest are in place.
							{:else}
								Done: the group now has exactly the rules below for these honeypots.
							{/if}
						</p>
						{#if resultado.pasos.length}
							<table class="abrir">
								<thead>
									<tr
										><th>Rule</th><th>Honeypot</th><th>Address</th><th>Ports</th><th>Priority</th
										><th>Result</th></tr
									>
								</thead>
								<tbody>
									{#each resultado.pasos as p (p.regla)}
										<tr class:mal={!p.ok}>
											<td class="mono">{p.regla}</td>
											<td>{p.trampa ?? '—'}</td>
											<td class="mono"
												>{p.destino === '*' ? 'All addresses' : (p.destino ?? '—')}</td
											>
											<td class="mono"
												>{p.puertos.length
													? `${p.puertos.join(', ')}/${p.protocolo?.toLowerCase()}`
													: '—'}</td
											>
											<td class="mono">{p.prioridad ?? '—'}</td>
											<td
												>{#if !p.ok}Failed: {p.error}{:else if resultado.simulado}{QUE_HARIA[
														p.accion
													]}{:else}{QUE_HIZO[p.accion]}{/if}</td
											>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else}
							<p class="ayuda">
								There is nothing to open and no rule of these honeypots in the group.
							</p>
						{/if}
					{/if}
				{/if}
			</section>
		{/if}
	</div>
{/if}

<div class="rejilla">
	<div class="principal" hidden={pestana !== 'overview'}>
		<section class="panel bloque">
			<h2>What you can deploy here</h2>
			{#if d.queCabe.length}
				<p class="ayuda">
					{valen === 0
						? 'None of the honeypots in your subscription fit this target right now.'
						: valen === 1
							? '1 of the honeypots in your subscription fits.'
							: `${valen} of the honeypots in your subscription fit.`}
					This is checked with their default settings; you can change them when you deploy one.
				</p>
				<ul class="modulos">
					{#each d.queCabe as m (m.modulo)}
						<li class:vale={!!m.elegida}>
							<p class="modulo">
								<a href={resolve('/decoys/catalog/[modulo]', { modulo: m.modulo })}>{m.nombre}</a>
								{#if m.elegida}
									<span class="si">Fits: {enFrase(m.elegida.nombre)}</span>
									<!-- Una forma a mano no necesita el sensor del destino; en un sensor, que conteste. -->
									{#if opera && (m.elegida.ejecutor === 'manual@1' || d.sensor?.vivo)}
										<a
											class="poner"
											href={`${resolve('/decoys/new/[modulo]', { modulo: m.modulo })}?${new URLSearchParams({ destino: d.id })}`}
											>Deploy here</a
										>
									{/if}
								{:else}
									<span class="no">Does not fit here</span>
								{/if}
							</p>
							{#if m.motivo}
								<p class="motivo">{m.motivo.texto}</p>
							{/if}
							{#each m.elegida?.avisos ?? [] as a (a.codigo + a.texto)}
								<p class="aviso-via">{a.texto}</p>
							{/each}
							{#if !m.elegida || m.vias.length > 1}
								<details>
									<summary>Why</summary>
									<ul class="vias">
										{#each m.vias as v (v.via)}
											<li>
												<p>
													<b>{v.nombre}</b>
													<span class={v.vale ? 'si' : 'no'}
														>{v.vale ? 'fits' : 'does not fit'}</span
													>
												</p>
												{#each v.motivos as x (x.codigo + x.texto)}
													<p>
														{x.texto}
														<small class="mono" title="Support code">{x.codigo}</small>
													</p>
													{#if x.remedio}<p class="remedio">{x.remedio}</p>{/if}
												{/each}
												{#each v.avisos as x (x.codigo + x.texto)}
													<p class="aviso-via">{x.texto}</p>
												{/each}
											</li>
										{/each}
									</ul>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="ayuda">
					Your subscription does not include any honeypots yet. Once {data.operador} authorizes them,
					you will see here which ones fit this target.
				</p>
			{/if}
		</section>

		<section class="panel bloque">
			<h2>Honeypots here</h2>
			{#if d.trampas.length}
				<ul class="trampas">
					{#each d.trampas as t (t.id)}
						<li>
							{#if opera}
								<a href={resolve('/decoys/[id]', { id: t.id })}>{t.nombre}</a>
							{:else}
								<b>{t.nombre}</b>
							{/if}
							<span class="mono">{t.modulo}</span>
							<span class="estado"><EstadoTrampa estado={t.estado} motivo /></span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="ayuda">There are no honeypots on this target yet.</p>
			{/if}
			{#if d.sensor && !page.data.community}
				<!-- Desde aquí la plantilla ya sabe a qué sensor va: no hay que elegirlo otra vez. -->
				<p>
					<a
						class="boton"
						href="{resolve('/decoys/templates')}?sensor={encodeURIComponent(d.sensor.id)}"
						>Deploy a template on this sensor</a
					>
				</p>
			{/if}
		</section>

		{#if d.sensor && d.abrir.length && !page.data.community}
			<section class="panel bloque">
				<h2>Repeat this deployment elsewhere</h2>
				<p class="ayuda">
					Save the honeypots on this sensor as a template, with their ports and, if each has its own
					address, the same split. You can then deploy it on another sensor in one go.
				</p>
				<a
					class="boton"
					href="{resolve('/decoys/templates/builder')}?sensor={encodeURIComponent(d.sensor.id)}"
					>Save as template</a
				>
			</section>
		{/if}

		<section class="panel bloque">
			<h2>What is known about this target</h2>
			<p class="ayuda">
				It is reported by its sensor, known by the console, or entered by you in the form. If two
				sources report the same thing, the sensor takes precedence.
			</p>
			{#if d.hechos.length}
				<dl class="hechos">
					{#each d.hechos as h (h.clave)}
						<div>
							<dt>
								{h.nombre ?? h.clave}
								{#if h.nombre}<small class="mono">{h.clave}</small>{/if}
							</dt>
							<dd>
								<span class="valor-hecho">{h.texto}</span>
								<small>
									{[
										h.fuente && `reported by ${nombreFuente[h.fuente]}`,
										h.cuando && haceCuanto(h.cuando, data.ahora)
									]
										.filter(Boolean)
										.join(', ')}
									{#if h.motivo}<span class="mono motivo-hecho">{h.motivo}</span>{/if}
								</small>
							</dd>
						</div>
					{/each}
				</dl>
			{:else}
				<p class="ayuda">Nothing yet: describe it under "Edit".</p>
			{/if}
		</section>
	</div>

	<aside class="lateral" hidden={pestana !== 'settings'}>
		{#if opera}
			<form class="panel bloque" method="POST" action="?/editar" use:enhance>
				<h2>Edit</h2>
				{#if d.formulario.bloqueados.length}
					<p class="ayuda">What its sensor already reports cannot be changed here.</p>
				{/if}
				{#if form?.accion === 'editar' && form.errores}
					<ul class="errores" role="alert">
						{#each form.errores as e (e)}<li>{e}</li>{/each}
					</ul>
				{:else if form?.accion === 'editar' && form.mensaje}
					<p class="hecho" role="status">{form.mensaje}</p>
				{/if}
				{#key d}
					<FormularioDestino
						tipo={d.tipo}
						{valores}
						bloqueados={d.formulario.bloqueados}
						delSensor={d.formulario.delSensor}
						soSensor={d.formulario.so}
						direcciones={d.formulario.direcciones}
					/>
				{/key}
				<button class="boton principal enviar">Save changes</button>
			</form>
		{/if}

		{#if admin && !d.sensor && d.activo}
			<!-- Sin enhance: la página vuelve arriba, donde sale la línea. -->
			<form class="panel bloque" method="POST" action="?/instalar">
				<h2>Install a sensor here</h2>
				<p class="ayuda">
					Enroll a sensor for this machine and you get the line that installs it. Its sensor then
					reports what the machine is; what you entered here still applies to anything it does not
					report.
				</p>
				{#if form?.accion === 'instalar' && form.error}
					<p class="errores" role="alert">{form.error}</p>
				{/if}
				<label for="s-id">Sensor identifier</label>
				<input
					id="s-id"
					name="id"
					class="mono"
					value={form?.accion === 'instalar' ? form.id : d.id}
				/>
				<label for="s-nombre">Name</label>
				<input
					id="s-nombre"
					name="nombre"
					required
					value={form?.accion === 'instalar' ? form.nombre : d.nombre}
				/>
				<label for="s-ip">IP address of this machine</label>
				<input
					id="s-ip"
					name="ip"
					class="mono"
					placeholder="10.70.0.15"
					required={data.acceso.estado === 'restringida'}
					value={form?.accion === 'instalar' ? (form.ip ?? '') : ''}
				/>
				{#if data.consola.nombre}
					<label for="s-consola">Address of this console as seen from that machine</label>
					<input
						id="s-consola"
						name="consolaIp"
						class="mono"
						placeholder="Empty: it resolves {data.consola.nombre}"
						title="Only if that machine cannot resolve {data.consola
							.nombre} (a machine outside your network): the IP address it reaches this console at. The install line and the sensor then use it, still checking the certificate against the name"
						value={form?.accion === 'instalar'
							? (form.consolaIp ?? '')
							: (data.consola.propuesta ?? '')}
					/>
				{/if}
				<p class="ayuda">
					{#if data.acceso.estado === 'restringida'}
						Required: access to the console is limited, and this address joins the list so the
						sensor can connect.
					{:else}
						Optional: if you later limit who can open the console, it is already in the list.
					{/if}
				</p>
				<button class="boton enviar">Enroll and generate the line</button>
			</form>
		{/if}

		{#if d.sensor?.remoto && puede(page.data.usuario?.roles ?? [], 'ajustes')}
			<form class="panel bloque" method="POST" action="?/cortarToken&tab=settings" use:enhance>
				<h2>Revoke its token</h2>
				{#if form?.accion === 'cortar' && 'error' in form && form.error}
					<p class="errores" role="alert">{form.error}</p>
				{:else if form?.accion === 'cortar' && 'mensaje' in form}
					<p class="ok" role="status">{form.mensaje}</p>
				{/if}
				<p class="ayuda">
					If you suspect the token of this sensor has leaked, revoke it: it stops working at once.
					The sensor stays out, and its honeypots stop reporting, until you generate a new install
					line in <a href={resolve('/sensors')}>Sensors</a> and run it on its machine. A normal reinstall
					does not need this: its new token replaces the old one by itself.
				</p>
				<label class="confirmar">
					<input type="checkbox" name="entiendo" value="si" />
					I understand this sensor stops reporting until it is reinstalled.
				</label>
				<button class="boton peligro">Revoke token</button>
			</form>
		{/if}

		{#if opera}
			<form class="panel bloque" method="POST" action="?/baja" use:enhance>
				<h2>Remove target</h2>
				{#if form?.accion === 'baja' && form.error}
					<p class="errores" role="alert">{form.error}</p>
				{/if}
				{#if d.sensor}
					<p class="ayuda">
						This target is a sensor's machine: it is removed by removing the sensor, in
						<a href={resolve('/sensors')}>Sensors</a>.
					</p>
				{:else if d.trampas.length}
					<p class="ayuda">It has honeypots: remove them first.</p>
					<button class="boton peligro" disabled>Remove target</button>
				{:else}
					<p class="ayuda">It is deleted from the list. You can add it again whenever you like.</p>
					<button class="boton peligro">Remove target</button>
				{/if}
			</form>
		{/if}
	</aside>
</div>

<style>
	.abrir-nube {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 14px;
	}

	.abrir tr.mal td {
		color: var(--crit);
	}

	.direcciones {
		margin-top: 6px;
		font-size: 13px;
	}

	.confirmar {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		margin: 0 0 12px;
		font-weight: 400;
	}

	.volver {
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.cabecera {
		margin: 14px 0 20px;
		min-width: 0;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
		overflow-wrap: anywhere;
	}

	.linea,
	.nota-destino {
		margin: 6px 0 0;
		color: var(--ink-2);
		font-size: 14px;
		overflow-wrap: anywhere;
	}

	.nota-destino {
		max-width: 70ch;
		color: var(--ink-3);
	}

	.estado {
		font-weight: 600;
		color: var(--ok);
	}

	.estado.mal {
		color: var(--crit);
	}

	.ok {
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
	}

	.token {
		padding: 16px 18px 18px;
		margin: 0 0 16px;
		border-color: var(--accent);
	}

	.token h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.token p {
		font-size: 13px;
		color: var(--ink-2);
		margin: 6px 0;
	}

	.valor {
		padding: 10px 12px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		color: var(--ink) !important;
		word-break: break-all;
		user-select: all;
	}

	.avisos {
		padding: 4px 18px;
		margin: 0 0 16px;
		border-color: var(--warn);
	}

	.avisos:has(.grave) {
		border-color: var(--crit);
	}

	.avisos ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.avisos li {
		padding: 10px 0 10px 12px;
		border-bottom: 1px solid var(--line);
		box-shadow: inset 3px 0 0 var(--warn);
		font-size: 13px;
	}

	.avisos li:last-child {
		border-bottom: none;
	}

	.avisos li.grave {
		box-shadow: inset 3px 0 0 var(--crit);
	}

	.avisos p {
		margin: 0;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.avisos p:first-child {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		margin-bottom: 3px;
		color: var(--ink);
	}

	.avisos small {
		font-size: 11.5px;
		color: var(--ink-3);
	}

	/* Una columna: los datos y los ajustes van cada uno en su pestaña. */
	.rejilla {
		display: grid;
		gap: 16px;
		grid-template-columns: minmax(0, 1fr);
		max-width: 900px;
		align-items: start;
	}

	.principal[hidden],
	.lateral[hidden] {
		display: none;
	}

	@media (max-width: 1208px) {
		.rejilla {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.principal,
	.lateral {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}

	.bloque {
		padding: 18px 20px 20px;
		min-width: 0;
	}

	.bloque h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.ayuda {
		margin: 4px 0 10px;
		font-size: 13px;
		color: var(--ink-3);
	}

	.hecho {
		margin: 8px 0 4px;
		padding: 9px 14px;
		border-radius: var(--r-sm);
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
		font-size: 13px;
	}

	p.errores {
		padding-left: 14px;
	}

	.errores {
		margin: 8px 0 4px;
		padding: 10px 14px 10px 30px;
		border-radius: var(--r-sm);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
		color: var(--crit);
		font-size: 13px;
	}

	.enviar {
		margin-top: 16px;
	}

	.boton:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.modulos,
	.trampas,
	.vias {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.modulos > li {
		padding: 10px 0 10px 12px;
		border-bottom: 1px solid var(--line);
		box-shadow: inset 3px 0 0 var(--line-strong);
		font-size: 13.5px;
	}

	.modulos > li.vale {
		box-shadow: inset 3px 0 0 var(--ok);
	}

	.modulos > li:last-child {
		border-bottom: none;
	}

	.modulos p,
	.vias p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.modulo {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 10px;
	}

	.modulo a {
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
	}

	.modulo a:hover {
		color: var(--accent);
	}

	.si,
	.no {
		font-size: 12px;
		font-weight: 600;
	}

	.modulo a.poner {
		font-size: 12px;
		font-weight: 600;
		color: var(--accent);
	}

	.si {
		color: var(--ok);
	}

	.no {
		color: var(--ink-3);
	}

	.motivo {
		margin-top: 3px !important;
		color: var(--ink-2);
	}

	.aviso-via {
		margin-top: 3px !important;
		font-size: 12.5px;
		color: var(--warn);
	}

	details {
		margin-top: 5px;
		font-size: 12.5px;
	}

	summary {
		cursor: pointer;
		color: var(--accent);
		width: max-content;
	}

	.vias li {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		color: var(--ink-2);
	}

	.vias li p + p {
		margin-top: 3px;
	}

	.vias b {
		color: var(--ink);
		margin-right: 6px;
	}

	.vias small {
		font-size: 11px;
		color: var(--ink-3);
		margin-left: 4px;
	}

	.remedio {
		color: var(--ink);
	}

	.trampas li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 12px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	.trampas li:last-child {
		border-bottom: none;
	}

	.trampas .mono {
		font-size: 12px;
		color: var(--ink-3);
	}

	.trampas .estado {
		margin-left: auto;
		text-align: right;
		max-width: 100%;
	}

	.hechos {
		margin: 0;
	}

	.hechos div {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		gap: 2px 14px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}

	.hechos div:last-child {
		border-bottom: none;
	}

	.hechos dt {
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.hechos dt small {
		display: block;
		font-size: 11px;
		color: var(--ink-3);
	}

	.hechos dd {
		margin: 0;
		min-width: 0;
	}

	.valor-hecho {
		overflow-wrap: anywhere;
	}

	.hechos dd small {
		display: block;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.motivo-hecho::before {
		content: '· ';
	}

	@media (max-width: 520px) {
		.hechos div {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.abrir {
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	.abrir th,
	.abrir td {
		text-align: left;
		padding: 0.3rem 1.25rem 0.3rem 0;
	}
	.abrir th {
		font-weight: 600;
		opacity: 0.75;
	}
</style>
