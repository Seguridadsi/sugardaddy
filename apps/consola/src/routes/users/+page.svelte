<script lang="ts">
	import { enhance } from '$app/forms';
	import { sinVaciar } from '$lib/guardar';
	import { haceCuanto } from '$lib/formato';

	let { data, form } = $props();

	const bloqueado = (hasta: string | null) => !!hasta && Date.parse(hasta) > Date.now();
</script>

<svelte:head>
	<title>Users — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Local users</h1>
	<a href="/settings">Settings</a>
</div>

<p class="ayuda">
	People who sign in to this console with a username and password stored on the node itself. The
	role decides what each person can do. Passwords are stored as one-way hashes (they cannot be
	read); if someone forgets theirs, reset it here and they will change it on sign-in.
</p>

{#if form?.mensaje}<p class="mensaje" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

<form class="panel bloque" method="POST" action="?/crear" use:enhance>
	<h2>Add user</h2>
	<div class="rejilla">
		<label>
			<span>Username</span>
			<input name="usuario" autocapitalize="off" spellcheck="false" required data-con-gestor />
		</label>
		<label>
			<span>Name</span>
			<input name="nombre" />
		</label>
		<label>
			<span>Email</span>
			<input name="correo" type="email" required data-con-gestor />
		</label>
		<label>
			<span>Initial password (min. {data.minimo})</span>
			<input
				name="clave"
				type="text"
				autocomplete="off"
				minlength={data.minimo}
				required
				data-con-gestor
			/>
		</label>
	</div>
	<fieldset class="roles">
		<legend>Roles</legend>
		{#each data.roles as rol (rol)}
			<label class="rol"><input type="checkbox" name="rol" value={rol} />{rol}</label>
		{/each}
	</fieldset>
	<button class="boton principal">Create</button>
</form>

{#if data.usuarios.length === 0}
	<p class="ayuda">There are no local users yet.</p>
{/if}

{#each data.usuarios as u (u.id)}
	<section class="panel bloque usuario">
		<div class="quien">
			<b class="mono">{u.usuario}</b>
			<span
				>{u.nombre}{#if u.correo}
					· {u.correo}{/if}</span
			>
			<span class="etiquetas">
				{#each u.roles as r (r)}<span class="chip">{r}</span>{/each}
				{#if u.debeCambiar}<span class="chip aviso">must change password on sign-in</span>{/if}
				{#if bloqueado(u.bloqueadoHasta)}<span class="chip malo">locked after failed attempts</span
					>{/if}
			</span>
			<span class="ayuda">
				{#if u.ultimoAcceso}Last sign-in {haceCuanto(u.ultimoAcceso)}{:else}Never signed in{/if}
			</span>
		</div>

		<div class="acciones">
			<form method="POST" action="?/roles" use:enhance={sinVaciar}>
				<input type="hidden" name="id" value={u.id} />
				<fieldset class="roles">
					<legend>Roles</legend>
					{#each data.roles as rol (rol)}
						<label class="rol">
							<input type="checkbox" name="rol" value={rol} checked={u.roles.includes(rol)} />{rol}
						</label>
					{/each}
				</fieldset>
				<button class="boton">Save roles</button>
			</form>

			<form method="POST" action="?/restablecer" use:enhance>
				<input type="hidden" name="id" value={u.id} />
				<label class="linea">
					<span>New password (min. {data.minimo})</span>
					<input
						name="clave"
						type="text"
						autocomplete="off"
						minlength={data.minimo}
						required
						data-con-gestor
					/>
				</label>
				<button class="boton">Reset</button>
			</form>

			<form
				method="POST"
				action="?/retirar"
				use:enhance
				onsubmit={(e) => {
					if (!confirm(`Remove user ${u.usuario}?`)) e.preventDefault();
				}}
			>
				<input type="hidden" name="id" value={u.id} />
				<button class="boton peligro">Remove</button>
			</form>
		</div>
	</section>
{/each}

<style>
	.cabecera {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.bloque {
		padding: 18px 20px;
		margin-bottom: 16px;
	}

	.rejilla {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
		margin-bottom: 12px;
	}

	label span {
		display: block;
		font-size: 12px;
		color: var(--ink-3);
		margin-bottom: 4px;
	}

	input[type='text'],
	input[type='email'],
	input:not([type]) {
		width: 100%;
		padding: 8px 10px;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
		font-size: 14px;
	}

	.roles {
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		padding: 8px 12px 10px;
		margin: 0 0 12px;
		display: flex;
		flex-wrap: wrap;
		gap: 10px 16px;
	}

	.roles legend {
		font-size: 12px;
		color: var(--ink-3);
		padding: 0 4px;
	}

	.rol {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13.5px;
	}

	.usuario {
		display: grid;
		grid-template-columns: 1fr;
		gap: 14px;
	}

	.quien {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.quien > span {
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.etiquetas {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 2px;
	}

	.chip {
		font-size: 11.5px;
		padding: 1px 8px;
		border-radius: 99px;
		background: var(--accent-soft);
		color: var(--ink-2);
	}

	.chip.aviso {
		background: color-mix(in oklab, var(--warn) 18%, var(--surface));
	}

	.chip.malo {
		background: color-mix(in oklab, var(--crit) 16%, var(--surface));
		color: var(--crit);
	}

	.acciones {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 16px;
		align-items: end;
	}

	.linea span {
		display: block;
		font-size: 12px;
		color: var(--ink-3);
		margin-bottom: 4px;
	}

	.boton.peligro {
		border-color: color-mix(in oklab, var(--crit) 50%, var(--line));
		color: var(--crit);
	}

	.mensaje,
	.error {
		font-size: 13.5px;
		padding: 10px 12px;
		border-radius: var(--r-sm);
		margin: 0 0 16px;
	}

	.mensaje {
		background: var(--accent-soft);
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}
</style>
