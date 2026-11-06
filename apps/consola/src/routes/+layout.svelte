<script lang="ts">
	import '@sugardaddy/estilo/app.css';
	import { asset, resolve } from '$app/paths';
	import { page } from '$app/state';
	import { puede } from '$lib/permisos';
	import { enhance } from '$app/forms';

	let { data, children } = $props();

	const enlaces = [
		{ href: '/', texto: 'Resumen' },
		{ href: '/mapa', texto: 'Mapa' },
		{ href: '/eventos', texto: 'Eventos' },
		{ href: '/contrasenas', texto: 'Contraseñas' },
		{ href: '/trampas', texto: 'Trampas' },
		{ href: '/respuestas', texto: 'Respuesta' },
		{ href: '/listas', texto: 'Listas' },
		{ href: '/avisos', texto: 'Avisos y SIEM' },
		{ href: '/sensores', texto: 'Sensores' },
		{ href: '/logs', texto: 'Logs' },
		{ href: '/ajustes', texto: 'Ajustes' }
	] as const;

	/* Los destinos (la ficha de cada máquina y los que no tienen sensor) cuelgan de Sensores. */
	const actual = (href: string) =>
		href === '/'
			? page.url.pathname === '/'
			: page.url.pathname.startsWith(href) ||
				(href === '/sensores' && page.url.pathname.startsWith('/destinos'));
</script>

{#if data.usuario && data.cliente}
	<header class="barra">
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

		<nav>
			{#each enlaces.filter((e) => !['/avisos', '/ajustes', '/logs'].includes(e.href) || puede(data.usuario?.roles ?? [], 'ajustes')) as e (e.href)}
				<a href={resolve(e.href)} aria-current={actual(e.href) ? 'page' : undefined}>
					{e.texto}
				</a>
			{/each}
		</nav>

		<span class="nodo">
			{#if data.logo}
				<img class="logo" src="/marca/logo?h={data.logo}" alt="" />
			{/if}
			<span class="punto"></span>
			{data.cliente.nombre} · <span class="mono">{data.cliente.nodo}</span>
		</span>

		{#if data.usuario.oid?.startsWith('local:')}
			<a class="quien" href={resolve('/mi-cuenta')} title="Mi cuenta">{data.usuario.nombre}</a>
		{:else}
			<span class="quien" title={data.usuario.roles.join(', ')}>{data.usuario.nombre}</span>
		{/if}
		<form method="POST" action="/auth/logout">
			<button class="salir">Salir</button>
		</form>
	</header>

	{#if data.usuario.emergencia}
		<p class="emergencia">
			Entrada de emergencia ({data.usuario.nombre}). Dura una hora y todo lo que hagas queda en los
			logs.
		</p>
	{/if}

	{#if data.pentest}
		<p class="pentest">
			Modo pentest «{data.pentest.nombre}» hasta el {new Date(data.pentest.hasta).toLocaleString(
				'es-ES',
				{ day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }
			)}: lo de {data.pentest.ips.length ? data.pentest.ips.join(', ') : 'cualquier IP'} no avisa ni se
			bloquea. <a href="/origenes/pentest/{data.pentest.id}">Ver</a>
		</p>
	{/if}

	{#if data.soporte?.estado === 'abierto'}
		<p class="soporte">
			{#if data.usuario.soporte}
				Estás dentro con el acceso de soporte que abrió {data.cliente.nombre}, como
				{data.soporte.rol}{#if data.soporte.hasta}, hasta las
					{new Date(data.soporte.hasta).toLocaleTimeString('es-ES', {
						hour: '2-digit',
						minute: '2-digit'
					})}{/if}.
			{:else}
				{data.operador} tiene acceso de soporte ({data.soporte.rol})
				{#if data.soporte.hasta}
					hasta las
					{new Date(data.soporte.hasta).toLocaleTimeString('es-ES', {
						hour: '2-digit',
						minute: '2-digit'
					})}.
				{:else}
					hasta que lo cierres.
				{/if}
				<a href="/ajustes">Gestionar</a>
			{/if}
		</p>
	{:else if data.soporte?.estado === 'solicitado' && puede(data.usuario.roles, 'ajustes')}
		<p class="soporte">{data.operador} pide acceso de soporte. <a href="/ajustes">Revisar</a></p>
	{/if}

	{#if data.modoDesarrollo}
		<p class="desarrollo">
			Modo desarrollo: sin Entra ID configurado, todo el mundo entra como administrador.
		</p>
	{/if}

	{#if !data.identidad.decidido && puede(data.usuario.roles, 'ajustes')}
		<div class="actualizacion oferta dominio">
			<form class="pregunta" method="POST" action="/ajustes?/identidad">
				<label for="dominio-empresa">
					¿Cuál es el dominio de tu empresa? Las trampas tomarán nombres parecidos a los de tu red.
				</label>
				<input
					id="dominio-empresa"
					name="dominio"
					required
					value={data.dominioSugerido}
					placeholder="empresa.es"
					autocomplete="off"
					spellcheck="false"
				/>
				<button type="submit">Guardar</button>
			</form>
			<form method="POST" action="/ajustes?/identidad" use:enhance>
				<input type="hidden" name="omitir" value="si" />
				<button type="submit">Ahora no</button>
			</form>
		</div>
	{/if}

	{#if data.community && !data.gestionado && !data.autoActualizar.decidido && puede(data.usuario.roles, 'ajustes')}
		<div class="actualizacion oferta">
			<span>
				Registra tu correo, sin coste, y tendrás más trampas y actualizaciones automáticas.
				<a href="/ajustes#registro">Registrarme</a>
			</span>
			<form method="POST" action="/ajustes?/autoActualizar" use:enhance>
				<button type="submit">Ahora no</button>
			</form>
		</div>
	{/if}

	{#if data.actualizacion?.version}
		<p class="actualizacion">
			{#if data.autoActualizar.activo}
				Hay una versión nueva ({data.actualizacion.version}); tu nodo se pondrá al día solo.
			{:else}
				Hay una versión nueva ({data.actualizacion.version}).
				<a
					href="https://github.com/Seguridadsi/sugardaddy/blob/main/docs/INSTALACION.md#actualizar"
					rel="noopener noreferrer">Cómo actualizar</a
				>
				{#if data.community}o <a href="/ajustes#registro">regístrate para que se instale sola</a
					>{/if}.
			{/if}
		</p>
	{/if}

	<main class="contenido">
		{@render children()}
		<!-- El país y la red de cada IP salen de las bases de DB-IP, cuya licencia pide citarlas. -->
		{#if data.geo}
			<footer class="pie">
				Geolocalización de IP:
				<a href="https://db-ip.com" rel="noopener noreferrer">DB-IP</a>, con licencia
				<a href="https://creativecommons.org/licenses/by/4.0/deed.es" rel="noopener noreferrer"
					>CC BY 4.0</a
				>.
			</footer>
		{/if}
	</main>
{:else}
	{@render children()}
{/if}

<style>
	.abeja {
		display: block;
	}

	.quien {
		font-size: 13px;
		color: var(--ink-2);
		text-decoration: none;
	}

	a.quien:hover {
		color: var(--ink);
		text-decoration: underline;
	}

	.salir {
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: 6px 13px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
	}

	.salir:hover {
		background: var(--surface-2);
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

	.nodo {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		color: var(--ink-2);
	}
	.punto {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
		box-shadow: 0 0 0 3px color-mix(in oklab, var(--ok) 25%, transparent);
	}

	.logo {
		height: 22px;
		max-width: 120px;
		object-fit: contain;
		margin-right: 4px;
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
