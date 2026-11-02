<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Antes de entrar — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	{#if data.pideClave && data.pideCorreo}
		<h1>Antes de entrar</h1>
		<p class="sub">
			Has entrado con una contraseña de un solo uso: elige una nueva (al menos {data.minimo} caracteres,
			mejor una frase larga) y pon tu correo. Si un día pierdes la contraseña, te mandaremos ahí un código
			para entrar.
		</p>
	{:else if data.pideClave}
		<h1>Cambia tu contraseña</h1>
		<p class="sub">
			Has entrado con una contraseña de un solo uso. Elige una nueva para seguir; al menos {data.minimo}
			caracteres (mejor una frase larga).
		</p>
	{:else}
		<h1>Pon tu correo</h1>
		<p class="sub">
			Si un día pierdes la contraseña, te mandaremos ahí un código para entrar. Luego lo puedes
			cambiar en «Mi cuenta».
		</p>
	{/if}

	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<form method="POST" use:enhance>
		<input type="hidden" name="volverA" value={data.volverA} />
		{#if data.pideCorreo}
			<label class="campo">
				<span>Tu correo</span>
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
				<span>Nueva contraseña</span>
				<input
					name="clave"
					type="password"
					autocomplete="new-password"
					minlength={data.minimo}
					required
				/>
			</label>
			<label class="campo">
				<span>Repítela</span>
				<input
					name="repetir"
					type="password"
					autocomplete="new-password"
					minlength={data.minimo}
					required
				/>
			</label>
		{/if}
		<button class="boton principal">Guardar y entrar</button>
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
