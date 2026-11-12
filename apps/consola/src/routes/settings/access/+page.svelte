<script lang="ts">
	import { page } from '$app/state';
	import { fechaHora } from '$lib/fechas-pantalla';

	let { data, form } = $props();
	const a = $derived(data.acceso);

	type Fila = { red: string; nota: string; sensor?: string };

	/*
	 * Lo que se enseña para editar: lo guardado, o, la primera vez, la IP de
	 * este navegador y la que propuso el instalador. Detrás, las máquinas de los
	 * sensores remotos que ya conectan desde fuera de la lista: si no, al
	 * guardar se quedarían sin llegar a la consola.
	 */
	function filasIniciales(): Fila[] {
		if (form?.filas?.length) return form.filas.map((f) => ({ ...f, nota: f.nota ?? '' }));
		const r: Fila[] = data.acceso.entradas.map((e) => ({ ...e }));
		if (!r.length) {
			if (data.ip && !data.local) r.push({ red: data.ip, nota: 'This browser' });
			if (data.propuesta && data.propuesta !== data.ip)
				r.push({ red: data.propuesta, nota: 'Where the node was installed from (SSH)' });
		}
		for (const x of data.sensoresFuera)
			if (!r.some((f) => f.red === x.direccion))
				r.push({ red: x.direccion, nota: `Remote sensor ${x.nombre}`, sensor: x.id });
		return r.length ? r : [{ red: '', nota: '' }];
	}
	let filas = $state<Fila[]>(filasIniciales());

	const ESTADO_CORTAFUEGOS: Record<string, string> = {
		aplicada: 'The machine firewall applies the list.',
		abierta: 'The machine firewall lets everyone through.',
		'sin-docker-user':
			'This machine does not let the node manage its firewall (Docker without iptables): the console port still answers everyone. The console hides its pages from addresses outside the list, but its port, certificate and images can still be seen.',
		error: 'The machine firewall could not be updated.'
	};
</script>

<svelte:head>
	<title>Console access — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Console access</h1>
</div>

{#if page.url.searchParams.has('guardado')}
	<p class="mensaje" role="status">
		Saved. In about a minute the console port stops answering addresses outside the list.
		{#if data.configuracion.pendiente}<a href="/setup">Continue setup</a>{/if}
	</p>
{/if}
{#if page.url.searchParams.has('abierta')}
	<p class="mensaje" role="status">
		The console stays open to everyone.
		{#if data.configuracion.pendiente}<a href="/setup">Continue setup</a>{/if}
	</p>
{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

<section class="panel bloque">
	<h2>Who can open this console</h2>
	<p class="ayuda">
		The console runs on the same machine and IP address as the honeypots. Anyone who scans the
		network and opens that address sees this console's sign-in page, and knows the machine is a
		honeypot. With a list, the console port only answers the addresses in it: to everyone else it
		looks closed.
	</p>

	{#if a.estado === 'restringida'}
		<p class="estado bien">
			Limited to {a.entradas.length}
			{a.entradas.length === 1 ? 'address or network' : 'addresses or networks'}{#if a.cambiado},
				since
				{fechaHora(a.cambiado)}{/if}.
		</p>
	{:else if a.estado === 'abierta'}
		<p class="estado mal">
			{#if a.emergencia}
				Open to everyone: it was opened from the machine with the emergency file.
			{:else}
				Open to everyone{#if a.quien}, by {a.quien}{/if}.
			{/if}
		</p>
	{:else}
		<p class="estado mal">
			Not limited yet: anyone who reaches this machine sees the console. Choose who can open it.
		</p>
	{/if}

	{#if a.estado === 'restringida'}
		{#if data.confirmado}
			<p class="ayuda">
				{ESTADO_CORTAFUEGOS.aplicada}
				<span class="cuando">({fechaHora(data.cortafuegos!.cuando)})</span>
			</p>
		{:else if data.cortafuegos && data.cortafuegos.estado !== 'aplicada'}
			<p class="aviso">
				{ESTADO_CORTAFUEGOS[data.cortafuegos.estado]}
				{#if data.cortafuegos.estado === 'error'}<code>{data.cortafuegos.detalle}</code>{/if}
				<span class="cuando">({fechaHora(data.cortafuegos.cuando)})</span>
			</p>
		{:else}
			<p class="aviso">
				The machine firewall has not confirmed this list yet. It usually takes under a minute; if it
				does not, the node updater is not running or is older than this console.
			</p>
		{/if}
	{/if}

	{#if data.sensoresFuera.length}
		<p class="aviso">
			These remote sensors connect from addresses outside the saved list, and are added below so
			they keep reaching the console:
			{#each data.sensoresFuera as x, i (x.id)}{i ? ', ' : ''}<strong>{x.nombre}</strong>
				(<code>{x.direccion}</code>){/each}.
		</p>
	{/if}
	{#if data.sensoresSinDireccion.length}
		<p class="aviso">
			Not connected since this version, so their address is unknown:
			{#each data.sensoresSinDireccion as x, i (x.id)}{i ? ', ' : ''}<strong>{x.nombre}</strong
				>{/each}. Add the address of their machines if you know it.
		</p>
	{/if}

	<p class="ayuda">
		{#if data.local}
			You are on the machine itself: from here you can always get in.
		{:else if data.ip}
			Your IP address, as the console sees it: <code>{data.ip}</code>. It must be in the list.
		{/if}
	</p>

	<form method="POST" action="?/limitar" class="lista-acceso">
		<input type="hidden" name="version" value={a.version ?? 0} />
		<div class="filas">
			<span class="titulo">IP address or network (CIDR)</span>
			<span class="titulo">Note</span>
			<span></span>
			{#each filas as f, i (i)}
				<input
					name="red"
					bind:value={f.red}
					placeholder="10.0.5.20 or 192.168.10.0/24"
					autocomplete="off"
					spellcheck="false"
					aria-label="IP address or network {i + 1}"
				/>
				<input
					name="nota"
					bind:value={f.nota}
					maxlength="80"
					placeholder="Admin PC, bastion host, provider…"
					aria-label="Note {i + 1}"
				/>
				<input type="hidden" name="sensor" value={f.sensor ?? ''} />
				<button
					type="button"
					class="boton pequeno"
					onclick={() => (filas = filas.filter((_, j) => j !== i))}
					disabled={filas.length === 1}>Remove</button
				>
			{/each}
		</div>
		<p>
			<button
				type="button"
				class="boton pequeno"
				onclick={() => (filas = [...filas, { red: '', nota: '' }])}
				disabled={filas.length >= data.maximo}>Add another</button
			>
		</p>
		<p class="ayuda">
			Remote sensors connect through this same port: their machines join the list when you add them
			under Sensors. If your provider supports you remotely, add their address too. The buttons in
			alert messages (email, Telegram, WhatsApp) open this console, so from a phone outside the list
			they will not load.
		</p>
		{#if form?.error?.includes('would stop reaching the console')}
			<label class="confirmar">
				<input type="checkbox" name="cortarSensores" value="si" />
				Cut those remote sensors off: they will stop sending events and receiving updates.
			</label>
		{/if}
		<button class="boton principal">Limit access to this list</button>
	</form>
</section>

<section class="panel bloque">
	<h2>If you lock yourself out</h2>
	<p class="ayuda">
		Once the machine firewall applies the list, you can always get in from the machine itself. To
		open the console to everyone again, run this on the machine; the console will say so until
		someone saves the list again:
	</p>
	<pre><code>sudo touch {data.carpeta}/abrir-consola</code></pre>
</section>

{#if a.estado !== 'abierta'}
	<section class="panel bloque">
		<h2>Leave it open to everyone</h2>
		<p class="ayuda">
			Only if the machine is already somewhere attackers cannot reach, for example a management
			network of its own. The console will keep reminding you.
		</p>
		<form method="POST" action="?/abrir">
			<label class="confirmar">
				<input type="checkbox" name="entiendo" value="si" required />
				I understand that anyone who reaches this machine will see the console sign-in page.
			</label>
			<button class="boton peligro">Leave it open</button>
		</form>
	</section>
{/if}

<style>
	.bloque {
		margin-bottom: 16px;
		padding: 18px 20px 20px;
		max-width: 760px;
	}
	.bloque h2 {
		font-size: 16px;
		font-weight: 600;
	}
	.estado {
		font-weight: 600;
	}
	.estado.bien {
		color: var(--ok);
	}
	.estado.mal {
		color: var(--crit);
	}
	.cuando {
		opacity: 0.7;
	}
	.filas {
		display: grid;
		grid-template-columns: minmax(12rem, 1fr) minmax(10rem, 1.4fr) auto;
		gap: 0.5rem;
		align-items: center;
		margin: 0.75rem 0;
	}
	.titulo {
		font-size: 0.85rem;
		opacity: 0.7;
	}
	.confirmar {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		margin-bottom: 0.75rem;
	}
	@media (max-width: 640px) {
		.filas {
			grid-template-columns: 1fr;
		}
		.titulo {
			display: none;
		}
	}
</style>
