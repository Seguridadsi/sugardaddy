<script lang="ts">
	import '@sugardaddy/estilo/app.css';
	import { ICONOS_MENU, type IconoMenu } from '@sugardaddy/estilo/iconos-menu';
	import { asset, resolve } from '$app/paths';
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { nombreRol, puede } from '$lib/permisos';
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import SelectorZona from '$lib/components/SelectorZona.svelte';
	import { anotarZonaDelNavegador, diaHora, horaCorta } from '$lib/fechas-pantalla';

	let { data, children } = $props();

	/* También en la pantalla de entrada: así lo primero que se ve al entrar ya sale en su zona. */
	onMount(() => {
		if (anotarZonaDelNavegador() && data.usuario) void invalidateAll();
	});

	const esAdmin = $derived(puede(data.usuario?.roles ?? [], 'ajustes'));

	/* El menú agrupa por lo que se va a hacer. Avisos y administración, solo para quien los puede usar. */
	const grupos = $derived(
		[
			{
				titulo: 'Overview',
				entradas: [
					{ href: '/', texto: 'Dashboard', icono: 'resumen' },
					{ href: '/map', texto: 'Deployment map', icono: 'mapa' }
				]
			},
			{
				titulo: 'Detect',
				entradas: [
					{ href: '/events', texto: 'Events', icono: 'eventos' },
					{ href: '/passwords', texto: 'Captured passwords', icono: 'contrasenas' }
				]
			},
			{
				titulo: 'Deploy',
				entradas: [
					{ href: '/decoys', texto: 'Decoys', icono: 'trampas' },
					{ href: '/sensors', texto: 'Sensors', icono: 'sensores' }
				]
			},
			{
				titulo: 'Respond',
				entradas: [
					{ href: '/responses', texto: 'Response', icono: 'respuestas' },
					{ href: '/lists', texto: 'Lists', icono: 'listas' },
					...(esAdmin ? [{ href: '/alerts', texto: 'Alerts & SIEM', icono: 'avisos' }] : [])
				]
			},
			{
				titulo: 'Admin',
				entradas: [
					...(esAdmin
						? [
								{ href: '/users', texto: 'Users', icono: 'usuarios' },
								{
									href: '/settings',
									hash: data.community ? '#free-registration' : '#central',
									texto: 'License',
									icono: 'licencia'
								},
								{ href: '/logs', texto: 'Audit logs', icono: 'logs' },
								{ href: '/settings', texto: 'Settings', icono: 'ajustes' }
							]
						: [])
				]
			}
		].filter((g) => g.entradas.length > 0) as {
			titulo: string;
			entradas: { href: string; hash?: string; texto: string; icono: IconoMenu }[];
		}[]
	);

	/* Los destinos (la ficha de cada máquina y los que no tienen sensor) cuelgan de Sensores. */
	const actual = (e: { href: string; hash?: string }) => {
		const ruta = page.url.pathname;
		if (e.hash) return ruta === e.href && page.url.hash === e.hash;
		if (e.href === '/') return ruta === '/';
		if (e.href === '/settings')
			return ruta.startsWith(e.href) && !['#free-registration', '#central'].includes(page.url.hash);
		return ruta.startsWith(e.href) || (e.href === '/sensors' && ruta.startsWith('/targets'));
	};

	/*
	 * Un solo aviso a la vez, el más importante, con los demás detrás. El orden
	 * es de importancia: primero lo que cambia quién está dentro o qué se ve.
	 */
	const avisos = $derived(
		(
			[
				data.usuario?.emergencia && 'emergencia',
				(data.soporte?.estado === 'abierto' ||
					(data.soporte?.estado === 'solicitado' && esAdmin)) &&
					'soporte',
				data.pentest && 'pentest',
				data.modoDesarrollo && 'desarrollo',
				!data.identidad.decidido && esAdmin && 'dominio',
				data.actualizacion?.version && 'actualizacion',
				data.community && !data.gestionado && !data.autoActualizar.decidido && esAdmin && 'oferta'
			] as (string | false | null | undefined)[]
		).filter(Boolean)
	);
	let indiceAviso = $state(0);
	const posicionAviso = $derived(Math.min(indiceAviso, Math.max(avisos.length - 1, 0)));
	const avisoActual = $derived(avisos[posicionAviso]);
	const pasarAviso = (paso: number) =>
		(indiceAviso = (posicionAviso + paso + avisos.length) % avisos.length);

	/* En un móvil el menú se abre encima de la página y se cierra al elegir. */
	let abierto = $state(false);
	afterNavigate(() => (abierto = false));
</script>

{#snippet icono(nombre: IconoMenu)}
	<svg class="menu-icono" viewBox="0 0 24 24" aria-hidden="true">
		{#each ICONOS_MENU[nombre] as d (d)}<path {d} />{/each}
	</svg>
{/snippet}

{#snippet marca()}
	<a class="marca" href={resolve('/')}>
		<img
			class="abeja"
			src={asset('/abeja-64.webp')}
			srcset="{asset('/abeja-64.webp')} 64w, {asset('/abeja-192.webp')} 192w"
			sizes="34px"
			alt=""
			width="34"
			height="34"
		/>
		<b>Sugardaddy</b>
	</a>
{/snippet}

{#if data.usuario && data.cliente}
	<div class="armazon">
		<header class="menu-movil">
			{@render marca()}
			<button
				class="menu-accion"
				type="button"
				aria-expanded={abierto}
				aria-controls="menu-lateral"
				onclick={() => (abierto = !abierto)}
			>
				{@render icono('menu')} Menu
			</button>
		</header>

		<button
			class="menu-fondo"
			class:abierto
			type="button"
			aria-label="Close menu"
			onclick={() => (abierto = false)}
		></button>

		<aside class="menu-lateral" class:abierto id="menu-lateral">
			{@render marca()}

			<p class="menu-nodo" title="{data.cliente.nombre} · {data.cliente.nodo}">
				{#if data.logo}
					<img class="logo" src="/marca/logo?h={data.logo}" alt="" />
				{/if}
				<span class="menu-punto"></span>
				<span>{data.cliente.nombre} · <span class="mono">{data.cliente.nodo}</span></span>
			</p>

			{#if puede(data.usuario.roles, 'desplegar')}
				<div class="menu-botones">
					<a class="menu-boton principal" href="/decoys#catalog">New decoy</a>
					{#if esAdmin}
						<a class="menu-boton" href="/sensors#install">Install sensor</a>
					{/if}
				</div>
			{/if}

			<nav class="menu-grupos" aria-label="Main menu">
				{#each grupos as g (g.titulo)}
					<div class="menu-grupo">
						<span class="menu-grupo-titulo">{g.titulo}</span>
						{#each g.entradas as e (e.texto)}
							<a href="{e.href}{e.hash ?? ''}" aria-current={actual(e) ? 'page' : undefined}>
								{@render icono(e.icono)}
								{e.texto}
							</a>
						{/each}
					</div>
				{/each}
			</nav>

			<div class="menu-cuenta">
				<span class="menu-cuenta-titulo">Signed in as</span>
				<div class="menu-persona" title={data.usuario.nombre}>
					<span class="menu-inicial">{data.usuario.nombre.trim().charAt(0).toUpperCase()}</span>
					<span>
						<b>{data.usuario.nombre}</b>
						<small>{data.cliente.nombre} · {nombreRol(data.usuario.roles)}</small>
					</span>
				</div>
				<SelectorZona guardada={data.zonaGuardada} navegador={data.zonaNavegador} />
				<div class="menu-cuenta-acciones">
					{#if data.usuario.oid?.startsWith('local:')}
						<a class="menu-accion" href={resolve('/account')}>{@render icono('cuenta')} Account</a>
					{/if}
					<form method="POST" action="/auth/logout">
						<button class="menu-accion">{@render icono('salir')} Sign out</button>
					</form>
				</div>
			</div>
		</aside>

		<div class="zona">
			{#if avisos.length}<div class="franja">
					<div class="franja-aviso">
						{#if avisoActual === 'emergencia'}
							<p class="emergencia">
								Emergency sign-in ({data.usuario.nombre}). It lasts one hour and everything you do
								is recorded in the audit logs.
							</p>
						{/if}

						{#if avisoActual === 'pentest' && data.pentest}
							<p class="pentest">
								Pentest mode "{data.pentest.nombre}" until {diaHora(data.pentest.hasta)}: activity
								from {data.pentest.ips.length ? data.pentest.ips.join(', ') : 'any IP'} does not raise
								alerts and is not blocked.
								<a href="/sources/pentest/{data.pentest.id}">View</a>
							</p>
						{/if}

						{#if avisoActual === 'soporte' && data.soporte?.estado === 'abierto'}
							<p class="soporte">
								{#if data.usuario.soporte}
									You are signed in with the support access opened by {data.cliente.nombre}, as {data
										.soporte.rol}{#if data.soporte.hasta}, until
										{horaCorta(data.soporte.hasta)}{/if}.
								{:else}
									{data.operador} has support access ({nombreRol(
										data.soporte.rol ? [data.soporte.rol] : []
									)}) {#if data.soporte.hasta}
										until
										{horaCorta(data.soporte.hasta)}.
									{:else}
										until you close it.
									{/if}
									<a href="/settings">Manage</a>
								{/if}
							</p>
						{:else if avisoActual === 'soporte'}
							<p class="soporte">
								{data.operador} is requesting support access. <a href="/settings">Review</a>
							</p>
						{/if}

						{#if avisoActual === 'desarrollo'}
							<p class="desarrollo">
								Development mode: Entra ID is not configured, so everyone signs in as an
								administrator.
							</p>
						{/if}

						{#if avisoActual === 'dominio'}
							<div class="actualizacion oferta dominio">
								<form class="pregunta" method="POST" action="/settings?/identidad">
									<label for="dominio-empresa">
										What is your company's domain? Decoys will use names similar to those on your
										network.
									</label>
									<input
										id="dominio-empresa"
										name="dominio"
										required
										value={data.dominioSugerido}
										placeholder="company.com"
										autocomplete="off"
										spellcheck="false"
									/>
									<button type="submit">Save</button>
								</form>
								<form method="POST" action="/settings?/identidad" use:enhance>
									<input type="hidden" name="omitir" value="si" />
									<button type="submit">Not now</button>
								</form>
							</div>
						{/if}

						{#if avisoActual === 'oferta'}
							<div class="actualizacion oferta">
								<span>
									Register your email, free of charge, to get more decoys and automatic updates.
									<a href="/settings#free-registration">Register</a>
								</span>
								<form method="POST" action="/settings?/autoActualizar" use:enhance>
									<button type="submit">Not now</button>
								</form>
							</div>
						{/if}

						{#if avisoActual === 'actualizacion'}
							<p class="actualizacion">
								{#if data.autoActualizar.activo}
									A new version is available ({data.actualizacion.version}); your node will update
									itself.
								{:else}
									A new version is available ({data.actualizacion.version}).
									<a
										href="https://github.com/Seguridadsi/sugardaddy/blob/main/docs/INSTALL.md#update"
										rel="noopener noreferrer">How to update</a
									>
									{#if data.community}or <a href="/settings#free-registration"
											>register so it installs automatically</a
										>{/if}.
								{/if}
							</p>
						{/if}
					</div>
					{#if avisos.length > 1}
						<div class="franja-pasar" role="group" aria-label="Notices">
							<button type="button" aria-label="Previous notice" onclick={() => pasarAviso(-1)}
								>‹</button
							>
							<span class="mono">{posicionAviso + 1}/{avisos.length}</span>
							<button type="button" aria-label="Next notice" onclick={() => pasarAviso(1)}>›</button
							>
						</div>
					{/if}
				</div>{/if}

			<main class="contenido">
				{@render children()}
				<!-- El país y la red de cada IP salen de las bases de DB-IP, cuya licencia pide citarlas. -->
				{#if data.geo}
					<footer class="pie">
						IP geolocation:
						<a href="https://db-ip.com" rel="noopener noreferrer">DB-IP</a>, licensed under
						<a href="https://creativecommons.org/licenses/by/4.0/deed.en" rel="noopener noreferrer"
							>CC BY 4.0</a
						>.
					</footer>
				{/if}
			</main>
		</div>
	</div>
{:else}
	{@render children()}
{/if}

<style>
	.abeja {
		display: block;
	}

	.franja {
		display: flex;
		align-items: stretch;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
	}

	.franja-aviso {
		flex: 1;
		min-width: 0;
	}

	.franja-pasar {
		display: flex;
		flex: none;
		align-items: center;
		gap: 4px;
		padding: 0 8px;
		font-size: 12px;
		color: var(--ink-2);
		border-left: 1px solid var(--line);
	}

	.franja-pasar button {
		padding: 2px 8px;
		border: 0;
		border-radius: var(--r-sm);
		background: none;
		color: inherit;
		font: inherit;
		font-size: 15px;
		cursor: pointer;
	}

	.franja-pasar button:hover {
		background: var(--surface-2);
		color: var(--ink);
	}

	.emergencia {
		margin: 0;
		padding: 7px 20px;
		font-size: 12.5px;
		font-weight: 700;
		background: var(--crit);
		color: var(--accent-ink);
	}

	.pentest {
		margin: 0;
		padding: 7px 20px;
		font-size: 12.5px;
		font-weight: 600;
		background: color-mix(in oklab, var(--warn) 16%, var(--surface));
		color: var(--warn);
	}

	.pentest a {
		color: inherit;
	}

	.soporte {
		margin: 0;
		padding: 7px 20px;
		font-size: 12.5px;
		font-weight: 600;
		background: color-mix(in oklab, var(--s-media) 16%, var(--surface));
		color: var(--s-media);
	}

	.soporte a {
		color: inherit;
		margin-left: 6px;
	}

	.desarrollo {
		margin: 0;
		padding: 7px 20px;
		font-size: 12.5px;
		font-weight: 600;
		background: color-mix(in oklab, var(--warn) 16%, var(--surface));
		color: var(--warn);
	}

	.actualizacion {
		margin: 0;
		padding: 7px 20px;
		font-size: 12.5px;
		font-weight: 600;
		background: color-mix(in oklab, var(--ok) 16%, var(--surface));
		color: var(--ok);
	}

	.actualizacion a {
		color: inherit;
		margin-left: 6px;
		font-weight: 700;
	}

	.actualizacion.oferta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.actualizacion.oferta form {
		margin: 0;
	}

	.actualizacion.dominio .pregunta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.actualizacion.dominio input {
		width: 180px;
		padding: 3px 7px;
		font: inherit;
		color: var(--ink-1);
		background: var(--surface);
		border: 1px solid currentColor;
		border-radius: var(--r-sm);
	}

	.actualizacion.oferta button {
		background: none;
		border: 1px solid currentColor;
		border-radius: var(--r-sm);
		color: inherit;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		padding: 3px 10px;
		cursor: pointer;
		white-space: nowrap;
	}

	.logo {
		height: 18px;
		max-width: 72px;
		object-fit: contain;
	}

	.pie {
		margin-top: 32px;
		font-size: 12px;
		color: var(--ink-3);
	}

	.pie a {
		color: inherit;
	}
</style>
