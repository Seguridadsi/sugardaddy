<script lang="ts">
	import type { EsquemaParametros } from '@sugardaddy/contrato';

	/*
	 * Pinta un formulario a partir del esquema de parámetros de un módulo. Así un
	 * módulo nuevo no necesita GUI propia. Las restricciones del navegador
	 * (pattern, min, max) son solo comodidad: quien decide es el servidor.
	 */
	type Campo = {
		type?: string;
		title?: string;
		description?: string;
		enum?: string[];
		default?: unknown;
		pattern?: string;
		format?: string;
		minimum?: number;
		maximum?: number;
		/* Extensiones de Sugardaddy: nombre de cada opción y texto de varias líneas. */
		'x-opciones'?: Record<string, string>;
		'x-multilinea'?: boolean;
		/* Elegir una trampa del cliente de esos módulos (§2.5). */
		'x-trampa'?: { modulos?: string[] };
		/* Ofrecer unas sugerencias que da el servidor (p. ej. 'direcciones': las IPs
		 * del sensor). Se pre-rellena la primera y el resto salen en una lista. */
		'x-sugerencias'?: string;
	};
	/* Una trampa a la que puede apuntar un parámetro x-trampa; con motivo, no se puede elegir. */
	type Objetivo = { id: string; nombre: string; destino: string; motivo: string | null };

	let {
		esquema,
		valores = {},
		objetivos = {},
		sugerencias = {}
	}: {
		esquema: EsquemaParametros;
		valores?: Record<string, unknown>;
		/* Las opciones de cada parámetro x-trampa, que calcula el servidor. */
		objetivos?: Record<string, Objetivo[]>;
		/* Sugerencias por clave de x-sugerencias (p. ej. 'direcciones' → IPs del sensor). */
		sugerencias?: Record<string, string[]>;
	} = $props();

	const campos = $derived(Object.entries(esquema.properties) as [string, Campo][]);
	const obligatorio = (k: string) => esquema.required?.includes(k) ?? false;
	const sugerenciasDe = (c: Campo) =>
		c['x-sugerencias'] ? (sugerencias[c['x-sugerencias']] ?? []) : [];
	/* Valor del campo: lo tecleado, el default del esquema o —si no hay nada— la
	 * primera sugerencia (p. ej. la IP del sensor), para no hacerlo teclear. */
	const valor = (k: string, c: Campo) => {
		if (valores[k] !== undefined) return String(valores[k]);
		if (c.default !== undefined && c.default !== null) return String(c.default);
		return sugerenciasDe(c)[0] ?? '';
	};
	/* Sin nada elegido, la única que vale ya va elegida. */
	function objetivoDe(k: string) {
		if (valores[k] !== undefined) return String(valores[k]);
		const validos = (objetivos[k] ?? []).filter((o) => !o.motivo);
		return validos.length === 1 ? validos[0].id : '';
	}
</script>

{#each campos as [clave, c] (clave)}
	<div class="campo">
		<label for="p-{clave}">
			{c.title ?? clave}
			{#if !obligatorio(clave)}<small>opcional</small>{/if}
		</label>
		{#if c['x-trampa']}
			{@const opciones = objetivos[clave] ?? []}
			<select
				id="p-{clave}"
				name="p.{clave}"
				value={objetivoDe(clave)}
				required={obligatorio(clave)}
			>
				<option value="" disabled
					>{opciones.length ? 'Elige una trampa' : 'No tienes ninguna trampa de este tipo'}</option
				>
				{#each opciones as o (o.id)}
					<option value={o.id} disabled={!!o.motivo}
						>{o.nombre}{o.destino ? ` · en ${o.destino}` : ''}{o.motivo
							? ` (${o.motivo})`
							: ''}</option
					>
				{/each}
			</select>
		{:else if c.enum}
			<select id="p-{clave}" name="p.{clave}" value={valor(clave, c)}>
				{#each c.enum as op (op)}
					<option value={op}>{c['x-opciones']?.[op] ?? op}</option>
				{/each}
			</select>
		{:else if c.type === 'integer' || c.type === 'number'}
			<input
				id="p-{clave}"
				name="p.{clave}"
				type="number"
				step={c.type === 'integer' ? 1 : 'any'}
				min={c.minimum}
				max={c.maximum}
				value={valor(clave, c)}
				required={obligatorio(clave)}
				class="mono"
			/>
		{:else if c.type === 'boolean'}
			<select id="p-{clave}" name="p.{clave}" value={valor(clave, c) || 'false'}>
				<option value="true">Sí</option>
				<option value="false">No</option>
			</select>
		{:else if c['x-multilinea']}
			<textarea
				id="p-{clave}"
				name="p.{clave}"
				rows="6"
				required={obligatorio(clave)}
				class="mono"
				spellcheck="false">{valor(clave, c)}</textarea
			>
		{:else}
			<input
				id="p-{clave}"
				name="p.{clave}"
				type={c.format === 'uri' ? 'url' : 'text'}
				pattern={c.pattern?.replace(/^\^|\$$/g, '')}
				value={valor(clave, c)}
				required={obligatorio(clave)}
				list={sugerenciasDe(c).length ? `sug-${clave}` : undefined}
				class="mono"
			/>
			{#if sugerenciasDe(c).length}
				<datalist id="sug-{clave}">
					{#each sugerenciasDe(c) as s (s)}<option value={s}></option>{/each}
				</datalist>
			{/if}
		{/if}
		{#if c.description}<p class="ayuda">{c.description}</p>{/if}
	</div>
{/each}

<style>
	label small {
		font-weight: 400;
		color: var(--ink-3);
		margin-left: 6px;
	}

	textarea {
		width: 100%;
		resize: vertical;
	}

	.ayuda {
		margin: 5px 0 0;
		font-size: 12px;
		color: var(--ink-3);
	}
</style>
