<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	const paso = $derived(form?.paso ?? (data.yaTengo ? 'codigo' : 'pedir'));
</script>

<svelte:head>
	<title>Reset your password — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	<h1>Forgot your password?</h1>

	{#if paso === 'pedir'}
		<p class="sub">
			Enter your username and we will send a code to the email address saved in the console.
		</p>
		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
		<form method="POST" action="?/pedir" use:enhance>
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
			<button class="boton principal">Send code</button>
		</form>
		<a class="enlace" href="?codigo">I already have a code</a>
	{:else}
		{#if form?.enviado}
			<p class="ok" role="status">
				If that user exists and has an email address, we have just sent a code. Check your spam
				folder too. It expires in {data.minutos} minutes.
			</p>
		{:else}
			<p class="sub">Enter the code sent to your email and your new password.</p>
		{/if}
		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
		<form method="POST" action="?/cambiar" use:enhance>
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
				<span>Code</span>
				<input
					name="codigo"
					inputmode="numeric"
					autocomplete="one-time-code"
					maxlength="7"
					required
				/>
			</label>
			<label class="campo">
				<span>New password (at least {data.minimo} characters)</span>
				<input
					name="clave"
					type="password"
					autocomplete="new-password"
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
					minlength={data.minimo}
					required
				/>
			</label>
			<button class="boton principal">Change password and sign in</button>
		</form>
		<a class="enlace" href="/sign-in/recover">Request another code</a>
	{/if}
	<a class="enlace" href="/sign-in">Back to sign in</a>
</div>

<style>
	.caja {
		width: min(380px, calc(100% - 32px));
		margin: 12vh auto 0;
		padding: 30px;
	}

	h1 {
		font-size: 19px;
		margin: 0 0 8px;
	}

	.sub {
		margin: 0 0 20px;
		color: var(--ink-3);
		font-size: 13.5px;
	}

	.error,
	.ok {
		font-size: 13.5px;
		margin: 0 0 16px;
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

	.campo {
		display: block;
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

	.boton {
		display: block;
		width: 100%;
		padding: 10px;
	}

	.enlace {
		display: block;
		margin-top: 14px;
		text-align: center;
		font-size: 12.5px;
		color: var(--ink-3);
	}
</style>
