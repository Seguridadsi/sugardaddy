<script lang="ts">
	import { startAuthentication } from '@simplewebauthn/browser';

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
	<h1>Entrada de emergencia</h1>
	<p class="sub">
		Con una llave FIDO2 registrada en este nodo. Funciona sin Entra y sin internet. Da rol de
		administrador y queda en la auditoría.
	</p>
	{#if estado === 'error'}<p class="error" role="alert">{mensaje}</p>{/if}
	<button class="boton principal" onclick={entrar} disabled={estado === 'esperando'}>
		{estado === 'esperando' ? 'Toca tu llave…' : 'Entrar con la llave'}
	</button>
	<a class="volver" href="/entrar">Volver a la entrada normal</a>
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
