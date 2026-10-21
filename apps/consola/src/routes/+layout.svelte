<script lang="ts">
	import '@sugardaddy/estilo/app.css';
	import { asset, resolve } from '$app/paths';
	import { page } from '$app/state';
	import { puede } from '$lib/permisos';

	let { data, children } = $props();

	const enlaces = [
		{ href: '/', texto: 'Resumen' },
		{ href: '/eventos', texto: 'Eventos' },
		{ href: '/contrasenas', texto: 'Contraseñas' },
		{ href: '/trampas', texto: 'Trampas' },
		{ href: '/listas', texto: 'Listas' },
		{ href: '/sensores', texto: 'Sensores' },
		{ href: '/destinos', texto: 'Destinos' },
		{ href: '/auditoria', texto: 'Auditoría' },
		{ href: '/ajustes', texto: 'Ajustes' }
	] as const;

	const actual = (href: string) =>
		href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
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
			{#each enlaces.filter((e) => !['/ajustes', '/auditoria'].includes(e.href) || puede(data.usuario?.roles ?? [], 'ajustes')) as e (e.href)}
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

		<span class="quien" title={data.usuario.roles.join(', ')}>{data.usuario.nombre}</span>
		<form method="POST" action="/auth/logout">
			<button class="salir">Salir</button>
		</form>
	</header>

	{#if data.usuario.emergencia}
		<p class="emergencia">
			Entrada de emergencia ({data.usuario.nombre}). Dura una hora y todo lo que hagas queda en la
			auditoría.
		</p>
	{/if}

	{#if data.soporte?.estado === 'abierto'}
		<p class="soporte">
			{#if data.usuario.soporte}
				Estás dentro con el acceso de soporte que abrió {data.cliente.nombre}, como {data.soporte
					.rol}, hasta las {new Date(data.soporte.hasta ?? '').toLocaleTimeString('es-ES', {
					hour: '2-digit',
					minute: '2-digit'
				})}.
			{:else}
				SeguridadSI tiene acceso de soporte ({data.soporte.rol}) hasta las
				{new Date(data.soporte.hasta ?? '').toLocaleTimeString('es-ES', {
					hour: '2-digit',
					minute: '2-digit'
				})}.
				<a href="/ajustes">Gestionar</a>
			{/if}
		</p>
	{:else if data.soporte?.estado === 'solicitado' && puede(data.usuario.roles, 'ajustes')}
		<p class="soporte">SeguridadSI pide acceso de soporte. <a href="/ajustes">Revisar</a></p>
	{/if}

	{#if data.modoDesarrollo}
		<p class="desarrollo">
			Modo desarrollo: sin Entra ID configurado, todo el mundo entra como administrador.
		</p>
	{/if}

	<main class="contenido">
		{@render children()}
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
</style>
