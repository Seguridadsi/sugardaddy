<script lang="ts">
	import { asset } from '$app/paths';
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Sign in — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	<!-- La consola va en oscuro: «Daddy» en claro. Con el tema claro, el logotipo original. -->
	<h1>
		<img
			class="logo oscuro"
			src={asset('/logo-fondo-oscuro-512.webp')}
			alt="Sugardaddy"
			width="200"
			height="193"
		/>
		<img
			class="logo claro"
			loading="lazy"
			src={asset('/logo-512.webp')}
			alt="Sugardaddy"
			width="200"
			height="193"
		/>
	</h1>
	<p class="sub">Node console</p>

	{#if form?.error}
		<p class="error" role="alert">{form.error}</p>
	{:else if data.error}
		<p class="error" role="alert">{data.error}</p>
	{:else if data.salida}
		<p class="ok" role="status">You have signed out.</p>
	{/if}

	{#if data.local}
		<form method="POST" action="?/local" use:enhance>
			<input type="hidden" name="volverA" value={data.volverA} />
			<label class="campo">
				<span>Username</span>
				<input
					name="usuario"
					autocomplete="username"
					autocapitalize="off"
					spellcheck="false"
					required
					value={form?.usuario ?? ''}
				/>
			</label>
			<label class="campo">
				<span>Password</span>
				<input name="clave" type="password" autocomplete="current-password" required />
			</label>
			<button class="boton principal">Sign in</button>
			<p class="pista">After several failed attempts the account is locked for a few minutes.</p>
			<a class="olvidada" href="/sign-in/recover">Forgot your password?</a>
		</form>
	{/if}

	{#if data.configurado}
		{#if data.local}<p class="o">or</p>{/if}
		<a
			class="boton principal"
			data-sveltekit-reload
			href="/auth/login?volverA={encodeURIComponent(data.volverA)}"
		>
			Sign in with Microsoft
		</a>
	{:else if !data.local}
		<p class="error">No sign-in method is configured for this console.</p>
	{/if}

	<a class="emergencia" href="/emergency">Emergency sign-in</a>
</div>

<style>
	.caja {
		width: min(380px, calc(100% - 32px));
		margin: 12vh auto 0;
		padding: 34px 30px 30px;
		text-align: center;
	}

	h1 {
		line-height: 0;
	}

	.logo {
		width: min(200px, 60vw);
		height: auto;
	}

	.claro,
	:global(:root[data-theme='light']) .oscuro {
		display: none;
	}

	:global(:root[data-theme='light']) .claro {
		display: inline;
	}

	.sub {
		margin: 10px 0 22px;
		color: var(--ink-3);
		font-size: 13.5px;
	}

	.error,
	.ok {
		font-size: 13.5px;
		margin: 0 0 18px;
		padding: 10px 12px;
		border-radius: var(--r-sm);
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}

	.ok {
		background: var(--accent-soft);
	}

	.olvidada {
		display: block;
		margin-top: 12px;
		font-size: 12.5px;
		color: var(--ink-3);
	}

	.emergencia {
		display: block;
		margin-top: 16px;
		font-size: 12.5px;
		color: var(--ink-3);
	}

	.boton {
		display: block;
		padding: 10px;
	}

	.campo {
		display: block;
		text-align: left;
		margin-bottom: 14px;
	}

	.campo span {
		display: block;
		font-size: 12.5px;
		color: var(--ink-3);
		margin-bottom: 5px;
	}

	.campo input {
		width: 100%;
		padding: 9px 11px;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
		font-size: 14px;
	}

	.campo input:focus {
		outline: 2px solid var(--accent);
		outline-offset: 0;
		border-color: transparent;
	}

	.o {
		margin: 16px 0;
		font-size: 12.5px;
		color: var(--ink-3);
	}

	.pista {
		margin: 10px 0 0;
		font-size: 11.5px;
		color: var(--ink-3);
		text-align: left;
	}
</style>
