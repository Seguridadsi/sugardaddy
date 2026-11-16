<script lang="ts">
	import { enhance } from '$app/forms';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import CodigosRecuperacion from '$lib/components/CodigosRecuperacion.svelte';

	let { data, form } = $props();

	let estado = $state<'listo' | 'esperando'>('listo');
	let mensaje = $state('');
	let codigosPasskey = $state<string[] | null>(null);
	let conRecuperacion = $state(false);
	let nombrePasskey = $state('');

	const codigos = $derived(codigosPasskey ?? (form && 'codigos' in form ? form.codigos : null));
	const recuperacion = $derived(conRecuperacion || !!(form && 'recuperacion' in form));

	async function pedir(ruta: string, cuerpo?: unknown) {
		const r = await fetch(ruta, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
		});
		const j = await r.json();
		if (!r.ok) throw new Error(j.message);
		return j;
	}

	async function conPasskey() {
		estado = 'esperando';
		mensaje = '';
		try {
			const opciones = await pedir('/sign-in/second-factor/passkey/options');
			if (data.modo === 'verificar') {
				const respuesta = await startAuthentication({ optionsJSON: opciones });
				const r = await pedir('/sign-in/second-factor/passkey/verify', { respuesta });
				location.href = r.ir;
			} else {
				const respuesta = await startRegistration({ optionsJSON: opciones });
				const r = await pedir('/sign-in/second-factor/passkey/verify', {
					respuesta,
					nombre: nombrePasskey
				});
				codigosPasskey = r.codigos;
			}
		} catch (e) {
			mensaje = (e as Error).message;
		}
		estado = 'listo';
	}
</script>

<svelte:head>
	<title>Two-factor authentication — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	{#if form?.error}
		<p class="error" role="alert">{form.error}</p>
	{:else if mensaje}
		<p class="error" role="alert">{mensaje}</p>
	{/if}

	{#if form?.fin}
		<a class="boton principal" href="/sign-in">Sign in again</a>
	{:else if codigos}
		<h1>Two-factor authentication is set up</h1>
		<CodigosRecuperacion {codigos} />
		<form method="POST" action="?/seguir">
			<button class="boton principal">I have saved them, continue</button>
		</form>
	{:else if data.modo === 'verificar'}
		<h1>Two-factor authentication</h1>
		{#if !recuperacion}
			{#if data.passkeys > 0}
				{#if data.porIp}
					<p class="sub">{data.porIp}</p>
				{:else}
					<button class="boton principal" onclick={conPasskey} disabled={estado === 'esperando'}>
						{estado === 'esperando' ? 'Waiting for your passkey…' : 'Use your passkey'}
					</button>
				{/if}
				{#if data.apps > 0}<p class="o">or</p>{/if}
			{/if}
			{#if data.apps > 0}
				<form method="POST" action="?/codigo" use:enhance>
					<label class="campo">
						<span>Code from your authenticator app</span>
						<input
							name="codigo"
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern="[0-9 ]*"
							maxlength="7"
							required
						/>
					</label>
					<button class="boton principal">Verify</button>
				</form>
			{/if}
			{#if data.codigos > 0}
				<button type="button" class="enlace" onclick={() => (conRecuperacion = true)}>
					Use a recovery code
				</button>
			{/if}
		{:else}
			<form method="POST" action="?/recuperacion" use:enhance>
				<label class="campo">
					<span>Recovery code (XXXXX-XXXXX)</span>
					<input
						name="codigo"
						autocomplete="off"
						autocapitalize="characters"
						spellcheck="false"
						required
					/>
				</label>
				<button class="boton principal">Sign in with the code</button>
			</form>
			<button type="button" class="enlace" onclick={() => (conRecuperacion = false)}> Back </button>
		{/if}
		<p class="pista">
			Lost your phone or passkey and your recovery codes? An administrator can reset your two-factor
			authentication from Users.
		</p>
	{:else}
		<h1>Set up two-factor authentication</h1>
		<p class="sub">
			This console requires a second step when you sign in. Set it up now: it takes a minute.
		</p>

		<h2>With a passkey</h2>
		<p class="ayuda">Your computer, phone or a security key (FIDO2). Phishing-resistant.</p>
		{#if data.porIp}
			<p class="ayuda">{data.porIp}</p>
		{:else}
			<label class="campo">
				<span>Name (optional)</span>
				<input bind:value={nombrePasskey} maxlength="60" placeholder="Work laptop" />
			</label>
			<button class="boton" onclick={conPasskey} disabled={estado === 'esperando'}>
				{estado === 'esperando' ? 'Waiting for your passkey…' : 'Create a passkey'}
			</button>
		{/if}

		{#if data.totp}
			<h2>With an authenticator app</h2>
			<p class="ayuda">
				Scan the code with Microsoft Authenticator, Google Authenticator or any TOTP app, then enter
				the 6-digit code it shows.
			</p>
			<img class="qr" src={data.totp.qr} alt="QR code for your authenticator app" />
			<p class="ayuda">Can't scan it? Enter this key: <code>{data.totp.secreto}</code></p>
			<form method="POST" action="?/alta" use:enhance>
				<label class="campo">
					<span>Name (optional)</span>
					<input name="nombre" maxlength="60" placeholder="My phone" />
				</label>
				<label class="campo">
					<span>Code from the app</span>
					<input
						name="codigo"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern="[0-9 ]*"
						maxlength="7"
						required
					/>
				</label>
				<button class="boton principal">Verify and continue</button>
			</form>
		{/if}
	{/if}
	<a class="volver" href="/sign-in">Back to sign-in</a>
</div>

<style>
	.caja {
		width: min(420px, calc(100% - 32px));
		margin: 10vh auto 40px;
		padding: 30px 30px 26px;
		text-align: center;
	}

	h1 {
		font-size: 20px;
		margin: 0 0 14px;
	}

	h2 {
		margin: 22px 0 2px;
		font-size: 15px;
		text-align: left;
	}

	.sub,
	.ayuda,
	.pista {
		color: var(--ink-3);
		font-size: 13px;
		text-align: left;
	}

	.sub {
		margin: 0 0 8px;
	}

	.ayuda {
		margin: 2px 0 10px;
	}

	.pista {
		margin: 18px 0 0;
		font-size: 12px;
	}

	.qr {
		display: block;
		width: 200px;
		height: 200px;
		margin: 6px auto 8px;
		image-rendering: pixelated;
	}

	.error {
		font-size: 13.5px;
		margin: 0 0 18px;
		padding: 10px 12px;
		border-radius: var(--r-sm);
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}

	.boton {
		display: block;
		width: 100%;
		padding: 10px;
	}

	form {
		margin-top: 6px;
	}

	.campo {
		display: block;
		text-align: left;
		margin-bottom: 12px;
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

	.o {
		margin: 14px 0;
		font-size: 12.5px;
		color: var(--ink-3);
	}

	.enlace {
		margin-top: 14px;
		background: none;
		border: 0;
		color: var(--ink-2);
		font-size: 12.5px;
		text-decoration: underline;
		cursor: pointer;
	}

	.volver {
		display: block;
		margin-top: 16px;
		font-size: 12.5px;
		color: var(--ink-3);
	}
</style>
