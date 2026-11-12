<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Before you sign in — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	{#if data.pideClave && data.pideCorreo}
		<h1>Before you sign in</h1>
		<p class="sub">
			You signed in with a one-time password: choose a new one (at least {data.minimo} characters; a long
			phrase is better) and enter your email. If you ever lose your password, we will send a code to that
			address so you can sign in.
		</p>
	{:else if data.pideClave}
		<h1>Change your password</h1>
		<p class="sub">
			You signed in with a one-time password. Choose a new one to continue; at least {data.minimo}
			characters (a long phrase is better).
		</p>
	{:else}
		<h1>Enter your email</h1>
		<p class="sub">
			If you ever lose your password, we will send a code to that address so you can sign in. You
			can change it later under "Account".
		</p>
	{/if}

	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<form method="POST" use:enhance>
		<input type="hidden" name="volverA" value={data.volverA} />
		<!-- Para que el navegador sepa de quién es la contraseña nueva y ofrezca guardarla. -->
		<input type="text" autocomplete="username" value={data.usuario} hidden readonly />
		{#if data.pideCorreo}
			<label class="campo">
				<span>Your email</span>
				<input
					name="correo"
					type="email"
					autocomplete="email"
					value={form?.correo ?? ''}
					maxlength="254"
					required
				/>
			</label>
		{/if}
		{#if data.pideClave}
			<label class="campo">
				<span>New password</span>
				<input
					name="clave"
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
		{/if}
		<button class="boton principal">Save and sign in</button>
	</form>
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

	.error {
		font-size: 13.5px;
		margin: 0 0 16px;
		padding: 10px 12px;
		border-radius: var(--r-sm);
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
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
</style>
