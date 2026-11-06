<script lang="ts">
	import FormularioParametros from '$lib/components/FormularioParametros.svelte';
	import type { EsquemaParametros } from '@sugardaddy/contrato';

	/*
	 * El formulario de credenciales de un módulo de respuesta: sus parámetros
	 * (pintados desde su esquema, como los de una trampa) y sus secretos. Un
	 * secreto guardado nunca se vuelve a enseñar: solo si está puesto y, si es
	 * largo, cómo acaba. Quien decide es el servidor, que lo vuelve a comprobar.
	 */
	type Secreto = { id: string; titulo: string; descripcion: string; obligatorio: boolean };
	type Guardado = { id: string; puesto: boolean; final: string | null };

	let {
		parametros,
		secretos,
		configuracion,
		guardados = [],
		claveLista,
		secretoIlegible = null
	}: {
		parametros: EsquemaParametros;
		secretos: readonly Secreto[];
		configuracion: Record<string, unknown>;
		guardados?: Guardado[];
		claveLista: boolean;
		secretoIlegible?: string | null;
	} = $props();

	const guardado = (id: string) => guardados.find((g) => g.id === id);
</script>

{#if Object.keys(parametros.properties).length}
	<FormularioParametros esquema={parametros} valores={configuracion} />
{/if}

{#if secretos.length}
	<div class="secretos">
		{#if secretoIlegible}
			<p class="aviso" role="alert">{secretoIlegible}</p>
		{/if}
		{#if !claveLista}
			<p class="aviso">
				This node does not have its key for storing secrets yet: it is created when the node is
				updated. Until then, this module cannot store any.
			</p>
		{/if}
		{#each secretos as x (x.id)}
			{@const g = guardado(x.id)}
			<div class="campo">
				<label for="s-{x.id}">{x.titulo}</label>
				<input
					id="s-{x.id}"
					name="s.{x.id}"
					type="password"
					class="mono"
					autocomplete="new-password"
					spellcheck="false"
					required={x.obligatorio && !g?.puesto}
					placeholder={g?.puesto
						? `Saved${g.final ? `, ends in …${g.final}` : ''}: enter a new one to change it`
						: ''}
				/>
				<p class="ayuda">
					{x.descripcion} It is stored encrypted with this node's key and is never shown again.
				</p>
			</div>
		{/each}
	</div>
{/if}

<style>
	.campo {
		margin: 14px 0 0;
	}

	.ayuda {
		margin: 5px 0 0;
		font-size: 12px;
		color: var(--ink-3);
	}

	.aviso {
		margin: 14px 0 0;
		padding: 9px 12px;
		border-radius: var(--r-sm);
		font-size: 13px;
		background: color-mix(in oklab, var(--warn) 12%, var(--surface));
		color: var(--warn);
	}
</style>
