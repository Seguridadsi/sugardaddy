<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { startRegistration } from '@simplewebauthn/browser';
	import Pestanas from '$lib/components/Pestanas.svelte';
	import CodigosRecuperacion from '$lib/components/CodigosRecuperacion.svelte';
	import { pestanaDe } from '$lib/pestanas';
	import { fechaCorta } from '$lib/fechas-pantalla';

	let { data, form } = $props();

	const PESTANAS = [
		{ id: 'profile', texto: 'Profile' },
		{ id: 'password', texto: 'Password' },
		{ id: 'two-factor', texto: 'Two-factor authentication' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));
	const sf = $derived(data.segundoFactor);

	let nombrePasskey = $state('');
	let esperando = $state(false);
	let errorPasskey = $state('');
	let codigosPasskey = $state<string[] | null>(null);
	const codigos = $derived(codigosPasskey ?? (form && 'codigos' in form ? form.codigos : null));
	const totp = $derived(form && 'totp' in form ? form.totp : null);

	async function anadirPasskey() {
		esperando = true;
		errorPasskey = '';
		try {
			const o = await fetch('/account/passkey/options', { method: 'POST' });
			if (!o.ok) throw new Error((await o.json()).message);
			const respuesta = await startRegistration({ optionsJSON: await o.json() });
			const r = await fetch('/account/passkey/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ respuesta, nombre: nombrePasskey })
			});
			const j = await r.json();
			if (!r.ok) throw new Error(j.message);
			nombrePasskey = '';
			if (j.codigos) codigosPasskey = j.codigos;
			const { invalidateAll } = await import('$app/navigation');
			await invalidateAll();
		} catch (e) {
			errorPasskey = (e as Error).message;
		}
		esperando = false;
	}
</script>

<svelte:head><title>Account — Sugardaddy</title></svelte:head>

<h1>Account</h1>

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Account sections" />

{#if form?.mensaje}<p class="aviso ok" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="aviso error" role="alert">{form.error}</p>{/if}

{#if pestana === 'profile'}
	<section class="tarjeta">
		<h2>Name</h2>
		<p class="sub">The name shown for you in the console.</p>
		<form method="POST" action="?/nombre" use:enhance>
			<label class="campo">
				<span>Name</span>
				<input name="nombre" type="text" value={data.nombre} maxlength="80" required />
			</label>
			<button class="boton">Save name</button>
		</form>
	</section>

	<section class="tarjeta">
		<h2>Email</h2>
		<p class="sub">
			If you lose your password, we send a code to this address so you can sign in again.
		</p>
		<form method="POST" action="?/correo" use:enhance>
			<label class="campo">
				<span>Email</span>
				<input
					name="correo"
					type="email"
					autocomplete="email"
					value={data.correo}
					maxlength="254"
					required
				/>
			</label>
			<label class="campo">
				<span>Current password</span>
				<input name="clave" type="password" autocomplete="current-password" required />
			</label>
			<button class="boton">Save email</button>
		</form>
	</section>
{:else if pestana === 'password'}
	<section class="tarjeta">
		<h2>Password</h2>
		<p class="sub">At least {data.minimo} characters; a long phrase is better than odd symbols.</p>
		<form method="POST" action="?/contrasena" use:enhance>
			<!-- Para que el navegador sepa de quién es la contraseña nueva y ofrezca guardarla. -->
			<input type="text" autocomplete="username" value={data.usuario} hidden readonly />
			<label class="campo">
				<span>Current password</span>
				<input name="actual" type="password" autocomplete="current-password" required />
			</label>
			<label class="campo">
				<span>New password</span>
				<input
					name="nueva"
					type="password"
					autocomplete="new-password"
					data-con-gestor
					minlength={data.minimo}
					required
				/>
			</label>
			<label class="campo">
				<span>Repeat new password</span>
				<input
					name="repetir"
					type="password"
					autocomplete="new-password"
					data-con-gestor
					minlength={data.minimo}
					required
				/>
			</label>
			<button class="boton">Change password</button>
		</form>
	</section>
{:else}
	{#if codigos}
		<section class="tarjeta">
			<h2>Your recovery codes</h2>
			<CodigosRecuperacion {codigos} />
		</section>
	{/if}

	<section class="tarjeta">
		<h2>Sign-in methods</h2>
		<p class="sub">
			After your password, the console asks for one of these.
			{#if sf.exigido}Two-factor authentication is required on this console.{/if}
		</p>
		{#if sf.factores.length === 0}
			<p class="sub">You have none yet.</p>
		{:else}
			<ul class="factores">
				{#each sf.factores as f (f.id)}
					<li>
						<div>
							<b>{f.nombre}</b>
							<small>
								{f.tipo === 'passkey' ? 'Passkey' : 'Authenticator app'} · added {fechaCorta(
									f.creada
								)}
								{#if f.ultimoUso}· last used {fechaCorta(f.ultimoUso)}{/if}
							</small>
						</div>
						<form method="POST" action="?/quitarFactor" use:enhance class="quitar">
							<input type="hidden" name="id" value={f.id} />
							<input
								name="clave"
								type="password"
								autocomplete="current-password"
								placeholder="Current password"
								aria-label="Current password"
								required
							/>
							<button class="boton peligro">Remove</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="tarjeta">
		<h2>Add a passkey</h2>
		<p class="sub">Your computer, phone or a security key (FIDO2). The most secure option.</p>
		{#if sf.porIp}
			<p class="sub">{sf.porIp}</p>
		{:else}
			{#if errorPasskey}<p class="aviso error" role="alert">{errorPasskey}</p>{/if}
			<label class="campo">
				<span>Name (optional)</span>
				<input bind:value={nombrePasskey} maxlength="60" placeholder="Work laptop" />
			</label>
			<button class="boton" onclick={anadirPasskey} disabled={esperando}>
				{esperando ? 'Waiting for your passkey…' : 'Add a passkey'}
			</button>
		{/if}
	</section>

	{#if sf.totp}
		<section class="tarjeta">
			<h2>Add an authenticator app</h2>
			{#if totp}
				<p class="sub">
					Scan the code with your app (Microsoft Authenticator, Google Authenticator or any TOTP
					app), then enter the 6-digit code it shows.
				</p>
				<img class="qr" src={totp.qr} alt="QR code for your authenticator app" />
				<p class="sub">Can't scan it? Enter this key: <code>{totp.legible}</code></p>
				<form method="POST" action="?/confirmarTotp" use:enhance>
					<input type="hidden" name="secreto" value={totp.secreto} />
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
					<button class="boton">Verify and add</button>
				</form>
			{:else}
				<p class="sub">A 6-digit code from an app on your phone.</p>
				<form method="POST" action="?/empezarTotp" use:enhance>
					<button class="boton">Set up an app</button>
				</form>
			{/if}
		</section>
	{/if}

	{#if sf.factores.length > 0}
		<section class="tarjeta">
			<h2>Recovery codes</h2>
			<p class="sub">
				{sf.codigos} of 10 left. Each one signs you in once if you lose your phone or passkey. Creating
				new ones cancels the previous ones.
			</p>
			<form method="POST" action="?/codigos" use:enhance>
				<label class="campo">
					<span>Current password</span>
					<input name="clave" type="password" autocomplete="current-password" required />
				</label>
				<button class="boton">Create new recovery codes</button>
			</form>
		</section>
	{/if}
{/if}

<style>
	.factores {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.factores li {
		display: grid;
		gap: 8px;
		padding: 10px 0;
		border-top: 1px solid var(--line);
	}

	.factores small {
		display: block;
		color: var(--ink-3);
		font-size: 12px;
	}

	.quitar {
		display: flex;
		gap: 8px;
	}

	.quitar input {
		flex: 1;
		min-width: 0;
	}

	.qr {
		display: block;
		width: 200px;
		height: 200px;
		margin: 4px 0 10px;
		image-rendering: pixelated;
	}

	h1 {
		font-size: 20px;
		margin: 0 0 18px;
	}

	.tarjeta {
		max-width: 460px;
		border: 1px solid var(--line);
		border-radius: var(--r-md, 10px);
		background: var(--surface);
		padding: 20px 22px;
		margin-bottom: 16px;
	}

	.tarjeta h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}

	.sub {
		margin: 0 0 16px;
		color: var(--ink-3);
		font-size: 13px;
	}

	.campo {
		display: block;
		margin-bottom: 13px;
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

	.boton {
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: 9px 16px;
		font-size: 13px;
		font-weight: 600;
		background: var(--surface-2);
		color: var(--ink);
		cursor: pointer;
	}

	.boton:hover {
		background: var(--surface-3, var(--surface-2));
	}

	.aviso {
		max-width: 460px;
		margin: 0 0 16px;
		padding: 10px 12px;
		border-radius: var(--r-sm);
		font-size: 13.5px;
	}

	.aviso.ok {
		color: var(--ok);
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
	}

	.aviso.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}
</style>
