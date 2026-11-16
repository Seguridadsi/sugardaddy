<script lang="ts">
	/*
	 * Las credenciales capturadas de un evento: en la lista van enmascaradas. Con el
	 * permiso ver-credenciales, un botón las pide (POST /events/<id>/credentials) y
	 * la consola apunta en la auditoría quién y cuándo. Se ven solo aquí, hasta
	 * cerrar el evento; nunca se guardan en el navegador.
	 */
	import { page } from '$app/state';
	import { puede } from '$lib/permisos';

	let { evento }: { evento: string } = $props();

	const permitido = $derived(
		puede((page.data.usuario?.roles ?? []) as string[], 'ver-credenciales')
	);
	let pidiendo = $state(false);
	let fallo = $state<string | null>(null);
	let reveladas = $state<{ k: string; v: string }[] | null>(null);

	async function revelar() {
		pidiendo = true;
		fallo = null;
		try {
			const r = await fetch(`/events/${evento}/credentials`, { method: 'POST' });
			const d = await r.json().catch(() => ({}));
			if (!r.ok) {
				fallo = d.error ?? d.message ?? 'The credentials could not be revealed.';
				return;
			}
			const campos = Object.entries((d.campos ?? {}) as Record<string, string>).map(([k, v]) => ({
				k,
				v
			}));
			if (d.contrasena && !campos.some((c) => c.v === d.contrasena))
				campos.unshift({ k: 'password', v: d.contrasena });
			reveladas = campos;
		} finally {
			pidiendo = false;
		}
	}
</script>

<div class="credencial">
	<span class="eyebrow">Captured credentials</span>
	{#if reveladas}
		<dl>
			{#each reveladas as c (c.k)}
				<div>
					<dt>{c.k}</dt>
					<dd class="mono">{c.v}</dd>
				</div>
			{/each}
		</dl>
		<button type="button" class="enlace" onclick={() => (reveladas = null)}>Hide</button>
	{:else if permitido}
		<p class="nota">
			Shown masked. Revealing them is recorded in the audit log.
			<button type="button" class="enlace" disabled={pidiendo} onclick={revelar}
				>{pidiendo ? 'Revealing…' : 'Reveal'}</button
			>
		</p>
	{:else}
		<p class="nota">Shown masked. Revealing them needs the Credential viewer role.</p>
	{/if}
	{#if fallo}<p class="nota error" role="alert">{fallo}</p>{/if}
</div>

<style>
	.credencial {
		margin: 8px 0;
	}

	.nota {
		font-size: 12.5px;
		color: var(--ink-2);
		margin: 4px 0;
	}

	.error {
		color: var(--crit);
	}

	dl {
		margin: 6px 0;
		display: grid;
		gap: 4px;
	}

	dl div {
		display: flex;
		gap: 10px;
	}

	dt {
		color: var(--ink-3);
		font-size: 12px;
		min-width: 110px;
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.enlace {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		font-size: 12px;
		color: var(--ink-2);
		text-decoration: underline;
		cursor: pointer;
	}
</style>
