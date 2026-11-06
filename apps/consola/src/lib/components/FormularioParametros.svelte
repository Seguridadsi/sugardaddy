<script lang="ts">
	import { untrack } from 'svelte';
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
		/*
		 * Solo se pide cuando otro parámetro (un desplegable) vale eso: el modo
		 * del correo. Si aquel tampoco se pide, este no (el gestor del ticket).
		 */
		'x-si'?: { campo: string; valor: string };
		/* Obligatorio cuando se pide (con x-si, el servidor lo comprueba en su modo). */
		'x-obligatorio'?: boolean;
		/* Un sí/no que se pinta como casilla (con su texto al lado) en vez de desplegable. */
		'x-casilla'?: boolean;
	};
	/* Una trampa a la que puede apuntar un parámetro x-trampa; con motivo, no se puede elegir. */
	type Objetivo = { id: string; nombre: string; destino: string; motivo: string | null };

	let {
		esquema,
		valores = {},
		objetivos = {},
		elegidos = $bindable()
	}: {
		esquema: EsquemaParametros;
		valores?: Record<string, unknown>;
		/* Las opciones de cada parámetro x-trampa, que calcula el servidor. */
		objetivos?: Record<string, Objetivo[]>;
		/* Lo elegido ahora en cada desplegable (para x-si); quien lo enlaza lo ve cambiar. */
		elegidos?: Record<string, string>;
	} = $props();

	const campos = $derived(Object.entries(esquema.properties) as [string, Campo][]);
	const valor = (k: string, c: Campo) => String(valores[k] ?? c.default ?? '');
	if (!elegidos)
		elegidos = untrack(() =>
			Object.fromEntries(
				(Object.entries(esquema.properties) as [string, Campo][])
					.filter(([, c]) => c.enum)
					.map(([k, c]) => [k, valor(k, c)])
			)
		);
	const visible = (c: Campo | undefined, vistos: string[] = []): boolean => {
		const si = c?.['x-si'];
		return (
			!si ||
			(elegidos?.[si.campo] === si.valor &&
				!vistos.includes(si.campo) &&
				visible(esquema.properties[si.campo] as Campo | undefined, [...vistos, si.campo]))
		);
	};
	const obligatorio = (k: string) =>
		(esquema.required?.includes(k) ?? false) ||
		!!(esquema.properties[k] as Campo | undefined)?.['x-obligatorio'];
	/*
	 * El pattern del esquema busca dentro del valor (JSON Schema: «^https://»
	 * es «empieza por https://»); el del navegador tiene que casar con todo el
	 * valor. Sin traducirlo, ninguna dirección pasaba de «^https://».
	 */
	function patronHtml(p: string | undefined): string | undefined {
		if (!p) return undefined;
		const desde = p.startsWith('^') ? p.slice(1) : `.*(?:${p})`;
		return desde.endsWith('$') && !desde.endsWith('\\$') ? desde.slice(0, -1) : `(?:${desde}).*`;
	}
	/* Sin nada elegido, la única que vale ya va elegida. */
	function objetivoDe(k: string) {
		if (valores[k] !== undefined) return String(valores[k]);
		const validos = (objetivos[k] ?? []).filter((o) => !o.motivo);
		return validos.length === 1 ? validos[0].id : '';
	}
</script>

{#each campos.filter(([, c]) => visible(c)) as [clave, c] (clave)}
	<div class="campo">
		{#if c['x-casilla']}
			<label class="casilla">
				<input
					id="p-{clave}"
					name="p.{clave}"
					type="checkbox"
					value="true"
					checked={valor(clave, c) === 'true'}
				/>
				{c.title ?? clave}
			</label>
		{:else}
			<label for="p-{clave}">
				{c.title ?? clave}
				{#if !obligatorio(clave)}<small>optional</small>{/if}
			</label>
		{/if}
		{#if c['x-casilla']}
			<!-- ya pintada arriba -->
		{:else if c['x-trampa']}
			{@const opciones = objetivos[clave] ?? []}
			<select
				id="p-{clave}"
				name="p.{clave}"
				value={objetivoDe(clave)}
				required={obligatorio(clave)}
			>
				<option value="" disabled
					>{opciones.length ? 'Choose a decoy' : 'You have no decoys of this type'}</option
				>
				{#each opciones as o (o.id)}
					<option value={o.id} disabled={!!o.motivo}
						>{o.nombre}{o.destino ? ` · on ${o.destino}` : ''}{o.motivo
							? ` (${o.motivo})`
							: ''}</option
					>
				{/each}
			</select>
		{:else if c.enum}
			<!-- Lo elegido manda: un desplegable que se esconde y vuelve a salir conserva lo que tenía. -->
			<select
				id="p-{clave}"
				name="p.{clave}"
				value={elegidos?.[clave] ?? valor(clave, c)}
				onchange={(e) => (elegidos = { ...elegidos, [clave]: e.currentTarget.value })}
			>
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
				<option value="true">Yes</option>
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
				pattern={patronHtml(c.pattern)}
				value={valor(clave, c)}
				required={obligatorio(clave)}
				class="mono"
			/>
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

	.casilla {
		display: inline-flex;
		align-items: flex-start;
		gap: 8px;
		font-weight: 600;
		cursor: pointer;
	}

	.casilla input {
		margin-top: 3px;
	}
</style>
