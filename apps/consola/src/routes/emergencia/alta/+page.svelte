<script lang="ts">
	import { page } from '$app/state';
	import { startRegistration } from '@simplewebauthn/browser';

	let nombre = $state('');
	let estado = $state<'listo' | 'esperando' | 'hecho' | 'error'>('listo');
	let mensaje = $state('');
	const codigo = $derived(page.url.searchParams.get('codigo'));

	async function registrar(e: SubmitEvent) {
		e.preventDefault();
		estado = 'esperando';
		try {
			const r = await fetch('/emergencia/alta/opciones', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nombre, codigo })
			});
			if (!r.ok) throw new Error((await r.json()).message);
			const respuesta = await startRegistration({ optionsJSON: await r.json() });
			const v = await fetch('/emergencia/alta/verificar', {
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
	<title>Registrar llave de emergencia — Sugardaddy</title>
</svelte:head>

<div class="caja panel">
	<h1>Registrar llave de emergencia</h1>
	{#if estado === 'hecho'}
		<p class="ok" role="status">
			Llave registrada. Guárdala en un sitio seguro: con ella se entra como administrador.
		</p>
		<a class="boton principal" href="/ajustes">Volver</a>
	{:else}
		<p class="sub">
			Una YubiKey o una passkey. Conviene registrar al menos dos y guardarlas por separado.
		</p>
		{#if estado === 'error'}<p class="error" role="alert">{mensaje}</p>{/if}
		<form onsubmit={registrar}>
			<label for="nombre">Nombre de la llave</label>
			<input
				id="nombre"
				bind:value={nombre}
				required
				minlength="3"
				placeholder="YubiKey de la caja fuerte"
			/>
			<button class="boton principal" disabled={estado === 'esperando'}>
				{estado === 'esperando' ? 'Toca tu llave…' : 'Registrar'}
			</button>
		</form>
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
