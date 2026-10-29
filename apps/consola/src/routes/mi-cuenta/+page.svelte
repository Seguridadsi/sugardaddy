<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
</script>

<svelte:head><title>Mi cuenta — Sugardaddy</title></svelte:head>

<h1>Mi cuenta</h1>

{#if form?.mensaje}<p class="aviso ok" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="aviso error" role="alert">{form.error}</p>{/if}

<section class="tarjeta">
	<h2>Nombre</h2>
	<p class="sub">El nombre con el que apareces en la consola.</p>
	<form method="POST" action="?/nombre" use:enhance>
		<label class="campo">
			<span>Nombre</span>
			<input name="nombre" type="text" value={data.nombre} maxlength="80" required />
		</label>
		<button class="boton">Guardar nombre</button>
	</form>
</section>

<section class="tarjeta">
	<h2>Contraseña</h2>
	<p class="sub">Al menos {data.minimo} caracteres; mejor una frase larga que símbolos raros.</p>
	<form method="POST" action="?/contrasena" use:enhance>
		<label class="campo">
			<span>Contraseña actual</span>
			<input name="actual" type="password" autocomplete="current-password" required />
		</label>
		<label class="campo">
			<span>Nueva contraseña</span>
			<input
				name="nueva"
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
		<button class="boton">Cambiar contraseña</button>
	</form>
</section>

<style>
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
