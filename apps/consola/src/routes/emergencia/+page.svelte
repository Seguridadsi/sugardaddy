<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { sinLlavePorIp } from '$lib/llave-por-ip';

	let { form } = $props();

	let estado = $state<'listo' | 'esperando' | 'error'>('listo');
	let mensaje = $state('');

	async function entrar() {
		estado = 'esperando';
		try {
			const r = await fetch('/emergencia/opciones', { method: 'POST' });
			if (!r.ok) throw new Error((await r.json()).message);
			const respuesta = await startAuthentication({ optionsJSON: await r.json() });
			const v = await fetch('/emergencia/verificar', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(respuesta)
			});
			if (!v.ok) throw new Error((await v.json()).message);
			location.href = '/';
		} catch (e) {
			estado = 'error';
			mensaje = (e as Error).message;
		}
	}
</script>

<svelte:head>
	<title>Entrada de emergencia — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	<span class="cuadro">!</span>
	{#if form?.nuevo}
		<h1>Ya estás dentro</h1>
		<p class="sub">
			El código que has usado ya no vale. Este es el nuevo: guárdalo donde guardabas el anterior. No
			se vuelve a enseñar.
		</p>
		<p class="codigo" aria-label="Código de emergencia nuevo"><code>{form.nuevo}</code></p>
		<p class="sub">
			Para volver a entrar como siempre, pon una contraseña nueva en Ajustes → Usuarios locales.
			Esta entrada dura una hora.
		</p>
		<a class="boton principal" href="/usuarios">Ya lo he guardado</a>
	{:else}
		<h1>Entrada de emergencia</h1>
		<p class="sub">
			Para entrar como administrador cuando no queda otra forma. Funciona sin Microsoft y sin
			internet, y queda en los logs.
		</p>

		<h2>Con tu código de emergencia</h2>
		<p class="sub">El que te enseñó el instalador (o Ajustes), con el formato XXXX-XXXX-…</p>
		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
		<form method="POST" action="?/codigo" use:enhance>
			<input
				name="codigo"
				aria-label="Código de emergencia"
				autocomplete="off"
				autocapitalize="characters"
				spellcheck="false"
				placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
				required
			/>
			<button class="boton principal">Entrar con el código</button>
		</form>

		<h2>Con una llave FIDO2</h2>
		{#if sinLlavePorIp(page.url.hostname)}
			<p class="sub">{sinLlavePorIp(page.url.hostname)}</p>
		{:else}
			<p class="sub">Si registraste una en Ajustes.</p>
			{#if estado === 'error'}<p class="error" role="alert">{mensaje}</p>{/if}
			<button class="boton" onclick={entrar} disabled={estado === 'esperando'}>
				{estado === 'esperando' ? 'Toca tu llave…' : 'Entrar con la llave'}
			</button>
		{/if}
		<a class="volver" href="/entrar">Volver a la entrada normal</a>
	{/if}
</div>

<style>
	.caja {
		max-width: 420px;
		margin: 12vh auto 0;
		padding: 34px 30px 30px;
		text-align: center;
	}

	.cuadro {
		display: inline-grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: var(--r-sm);
		background: var(--warn);
		color: var(--accent-ink);
		font-family: var(--font-display);
		font-weight: 700;
		font-size: 20px;
	}

	h1 {
		margin-top: 14px;
		font-size: 22px;
	}

	h2 {
		margin: 22px 0 0;
		font-size: 15px;
		text-align: left;
	}

	h2 + .sub {
		margin-top: 2px;
		margin-bottom: 10px;
		text-align: left;
	}

	form {
		display: grid;
		gap: 10px;
	}

	input {
		font-family: var(--font-mono);
		text-align: center;
		letter-spacing: 0.04em;
	}

	.codigo code {
		display: block;
		padding: 14px 10px;
		font-size: 17px;
		letter-spacing: 0.06em;
		background: var(--surface-2);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		user-select: all;
	}

	.sub {
		margin: 6px 0 20px;
		color: var(--ink-3);
		font-size: 13px;
	}

	.error {
		font-size: 13.5px;
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
		padding: 10px 12px;
		border-radius: var(--r-sm);
	}

	.boton {
		display: block;
		width: 100%;
		padding: 10px;
	}

	.volver {
		display: block;
		margin-top: 14px;
		font-size: 13px;
	}
</style>
