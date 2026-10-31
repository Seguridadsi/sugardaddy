<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const ETIQUETA_ESTADO: Record<string, string> = {
		revisado: 'Revisado',
		'falso-positivo': 'Falso positivo',
		interesante: 'Interesante'
	};
	const ETIQUETA_CRITERIO: Record<string, string> = {
		ip: 'IP o rango',
		usuario: 'Usuario',
		comando: 'Comando o texto',
		trampa: 'Trampa'
	};
	const PISTA: Record<string, string> = {
		ip: 'Una IP (10.0.0.5) o un rango CIDR (10.0.0.0/24, 2001:db8::/32).',
		usuario: 'El usuario exacto que probó el atacante (p. ej. root).',
		comando: 'Un texto a buscar en lo que tecleó o envió (p. ej. /etc/passwd).',
		trampa: 'Todos los eventos de esta trampa.'
	};

	/*
	 * El criterio y el valor del formulario. Arrancan del prefill (cuando se llega
	 * desde un perfil de IP o de usuario con «Crear regla para…»); si no, en blanco.
	 * El prefill se lee una vez (solo cambia al navegar, que remonta la página).
	 * El valor del input de texto y el del select de trampa son estados DISTINTOS:
	 * así cambiar de criterio no arrastra un valor de un control al otro (p. ej. el
	 * UUID de una trampa colándose como regla de usuario). Solo el control que se
	 * pinta —según el criterio— lleva name="valor" y es el que se envía.
	 */
	const prefill = untrack(() => data.prefill);
	let criterio = $state(prefill.criterio);
	let valorTexto = $state(prefill.criterio === 'trampa' ? '' : prefill.valor);
	let valorTrampa = $state(
		untrack(() =>
			prefill.criterio === 'trampa' && prefill.valor ? prefill.valor : (data.trampas[0]?.id ?? '')
		)
	);

	const nombreTrampa = (id: string) => data.nombres[id] ?? id;
</script>

<svelte:head>
	<title>Reglas de triaje — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<h1>Reglas de triaje automático</h1>
		<p class="sub">
			Marca solos los eventos nuevos que casen, para no triajar a mano lo repetitivo. Se aplican a
			los eventos que llegan a partir de ahora, no al histórico.
		</p>
	</div>
	<a class="volver" href="/eventos">← Eventos</a>
</div>

{#if form?.error}
	<p class="aviso error">{form.error}</p>
{:else if form?.mensaje}
	<p class="aviso ok">{form.mensaje}</p>
{/if}

{#if data.puedeEditar}
	<form method="POST" action="?/crear" class="panel nueva" use:enhance>
		<div class="campo">
			<label for="criterio">Cuando el evento…</label>
			<select id="criterio" name="criterio" bind:value={criterio}>
				{#each data.criterios as c (c)}
					<option value={c}>{ETIQUETA_CRITERIO[c] ?? c}</option>
				{/each}
			</select>
		</div>
		<div class="campo valor">
			<label for="valor">{criterio === 'trampa' ? 'es de la trampa' : 'casa'}</label>
			{#if criterio === 'trampa'}
				<select id="valor" name="valor" bind:value={valorTrampa}>
					{#each data.trampas as t (t.id)}
						<option value={t.id}>{t.nombre}</option>
					{/each}
				</select>
			{:else}
				<input
					id="valor"
					name="valor"
					class="mono"
					bind:value={valorTexto}
					placeholder={PISTA[criterio]}
					maxlength="200"
				/>
			{/if}
		</div>
		<div class="campo">
			<label for="estado">márcalo como</label>
			<select id="estado" name="estado">
				{#each data.estados as e (e)}
					<option value={e}>{ETIQUETA_ESTADO[e] ?? e}</option>
				{/each}
			</select>
		</div>
		<div class="campo nota">
			<label for="nota">con la nota (opcional)</label>
			<input id="nota" name="nota" placeholder="p. ej. escáner conocido" maxlength="2000" />
		</div>
		<button class="boton principal">Añadir regla</button>
		<p class="pista">{PISTA[criterio]}</p>
	</form>
{/if}

<section class="panel">
	{#if data.reglas.length === 0}
		<p class="vacio">Todavía no hay reglas de triaje automático.</p>
	{:else}
		<ul>
			{#each data.reglas as r (r.id)}
				<li class:inactiva={!r.activa}>
					<span class="crit">{ETIQUETA_CRITERIO[r.criterio] ?? r.criterio}</span>
					<span class="val mono">{r.criterio === 'trampa' ? nombreTrampa(r.valor) : r.valor}</span>
					<span class="flecha">→</span>
					<span class="estado triaje-{r.estado}">{ETIQUETA_ESTADO[r.estado] ?? r.estado}</span>
					{#if r.nota}<span class="notita">{r.nota}</span>{/if}
					{#if !r.activa}<span class="apagada">desactivada</span>{/if}
					{#if data.puedeEditar}
						<span class="acciones">
							<form method="POST" action="?/cambiarActiva" use:enhance>
								<input type="hidden" name="id" value={r.id} />
								<input type="hidden" name="activa" value={(!r.activa).toString()} />
								<button class="enlace">{r.activa ? 'Desactivar' : 'Activar'}</button>
							</form>
							<form method="POST" action="?/borrar" use:enhance>
								<input type="hidden" name="id" value={r.id} />
								<button class="enlace borrar">Borrar</button>
							</form>
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.cabecera {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(22px, 5vw, 30px);
		font-weight: 700;
	}

	.sub {
		margin: 6px 0 0;
		max-width: 60ch;
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.volver {
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		text-decoration: none;
	}

	.volver:hover {
		color: var(--ink);
	}

	.aviso {
		margin: 0 0 16px;
		padding: 10px 14px;
		border-radius: var(--r-sm);
		font-size: 13.5px;
		border: 1px solid var(--line);
	}

	.aviso.ok {
		color: var(--ok, #15803d);
		border-color: color-mix(in srgb, var(--ok, #15803d) 40%, var(--line));
	}

	.aviso.error {
		color: var(--warn);
		border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
	}

	.nueva {
		display: grid;
		grid-template-columns: auto minmax(180px, 1fr) auto minmax(160px, 1fr) auto;
		gap: 12px;
		align-items: end;
		padding: 16px 17px;
		margin-bottom: 16px;
	}

	.campo {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.campo label {
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.pista {
		grid-column: 1 / -1;
		margin: 0;
		font-size: 12px;
		color: var(--ink-3);
	}

	@media (max-width: 820px) {
		.nueva {
			grid-template-columns: 1fr;
			align-items: stretch;
		}
	}

	select,
	input {
		padding: 7px 9px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		color: var(--ink);
		font-size: 13.5px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		padding: 11px 17px;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	li:last-child {
		border-bottom: none;
	}

	li.inactiva {
		opacity: 0.55;
	}

	.crit {
		font-weight: 600;
		color: var(--ink-2);
	}

	.flecha {
		color: var(--ink-3);
	}

	.estado {
		padding: 1px 8px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 600;
		border: 1px solid var(--line);
		color: var(--ink-2);
		background: var(--surface-2);
	}

	.triaje-revisado {
		color: var(--ok, #15803d);
		border-color: color-mix(in srgb, var(--ok, #15803d) 40%, var(--line));
	}

	.triaje-interesante {
		color: var(--warn);
		border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
	}

	.notita {
		color: var(--ink-3);
		font-size: 12.5px;
	}

	.apagada {
		font-size: 11.5px;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.acciones {
		margin-left: auto;
		display: flex;
		gap: 12px;
	}

	.acciones form {
		display: inline;
	}

	.enlace {
		border: none;
		background: none;
		color: var(--ink-2);
		font-size: 12.5px;
		text-decoration: underline;
		cursor: pointer;
		padding: 0;
	}

	.enlace:hover {
		color: var(--ink);
	}

	.enlace.borrar:hover {
		color: var(--warn);
	}

	.vacio {
		padding: 28px 17px;
		margin: 0;
		text-align: center;
		color: var(--ink-2);
	}
</style>
