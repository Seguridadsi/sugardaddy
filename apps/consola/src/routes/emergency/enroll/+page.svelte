<script lang="ts">
	import { page } from '$app/state';
	import { startRegistration } from '@simplewebauthn/browser';
	import { sinLlavePorIp } from '$lib/llave-por-ip';

	let nombre = $state('');
	let estado = $state<'listo' | 'esperando' | 'hecho' | 'error'>('listo');
	let mensaje = $state('');
	const codigo = $derived(page.url.searchParams.get('codigo'));
	const porIp = $derived(sinLlavePorIp(page.url.hostname));

	async function registrar(e: SubmitEvent) {
		e.preventDefault();
		estado = 'esperando';
		try {
			const r = await fetch('/emergency/enroll/options', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nombre, codigo })
			});
			if (!r.ok) throw new Error((await r.json()).message);
			const respuesta = await startRegistration({ optionsJSON: await r.json() });
			const v = await fetch('/emergency/enroll/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(respuesta)
			});
			if (!v.ok) throw new Error((await v.json()).message);
			estado = 'hecho';
		} catch (err) {
			estado = 'error';
			mensaje = (err as Error).message;
		}
	}
</script>

<svelte:head>
	<title>Register emergency key — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	<h1>Register emergency key</h1>
	{#if estado === 'hecho'}
		<p class="ok" role="status">
			Key registered. Keep it somewhere safe: it signs in as an administrator.
		</p>
		<a class="boton principal" href="/settings">Back</a>
	{:else}
		<p class="sub">
			A YubiKey or a passkey. Register at least two and keep them in separate places.
		</p>
		{#if porIp}
			<p class="error" role="alert">{porIp}</p>
			<a class="boton principal" href="/settings">Go to the emergency code</a>
		{:else}
			{#if estado === 'error'}<p class="error" role="alert">{mensaje}</p>{/if}
			<form onsubmit={registrar}>
				<label for="nombre">Key name</label>
				<input id="nombre" bind:value={nombre} required minlength="3" placeholder="Safe YubiKey" />
				<button class="boton principal" disabled={estado === 'esperando'}>
					{estado === 'esperando' ? 'Touch your key…' : 'Register'}
				</button>
			</form>
		{/if}
	{/if}
</div>

<style>
	.caja {
		max-width: 440px;
		margin: 10vh auto 0;
		padding: 30px;
	}

	h1 {
		font-size: 21px;
	}

	.sub {
		margin: 6px 0 14px;
		color: var(--ink-3);
		font-size: 13px;
	}

	.error,
	.ok {
		font-size: 13.5px;
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

	.boton {
		display: block;
		width: 100%;
		margin-top: 16px;
		padding: 10px;
		text-align: center;
	}
</style>
