<script lang="ts" module>
	/*
	 * Las salidas de Avisos que puede elegir cada parámetro x-salida, por su
	 * clave: las de su tipo de canal, sin nada secreto (respuesta/config.ts).
	 */
	export type SalidasParaElegir = Record<
		string,
		{
			tipo: string;
			tipoNombre: string;
			opciones: { id: string; nombre: string; destino: string | null; activa: boolean }[];
		}
	>;
</script>

<script lang="ts">
	import { page } from '$app/state';
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
		/* Elegir una salida de Avisos de ese tipo de canal (las respuestas enviar-correo…). */
		'x-salida'?: { tipo: string };
	};
	/* Una trampa a la que puede apuntar un parámetro x-trampa; con motivo, no se puede elegir. */
	type Objetivo = { id: string; nombre: string; destino: string; motivo: string | null };

	let {
		esquema,
		valores = {},
		objetivos = {},
		salidas = {}
	}: {
		esquema: EsquemaParametros;
		valores?: Record<string, unknown>;
		/* Las opciones de cada parámetro x-trampa, que calcula el servidor. */
		objetivos?: Record<string, Objetivo[]>;
		/* Las de cada parámetro x-salida, que también calcula el servidor. */
		salidas?: SalidasParaElegir;
	} = $props();

	const campos = $derived(Object.entries(esquema.properties) as [string, Campo][]);
	const obligatorio = (k: string) => esquema.required?.includes(k) ?? false;
	const valor = (k: string, c: Campo) => String(valores[k] ?? c.default ?? '');
	/* Sin nada elegido, la única que vale ya va elegida. */
	function objetivoDe(k: string) {
		if (valores[k] !== undefined) return String(valores[k]);
		const validos = (objetivos[k] ?? []).filter((o) => !o.motivo);
		return validos.length === 1 ? validos[0].id : '';
	}
	/* Cómo se nombra el canal en una frase («el envío por correo electrónico»). */
	const enFrase = (nombre: string) => (nombre === 'Correo' ? 'correo electrónico' : nombre);

	/* Igual con las salidas: si solo hay una de ese tipo, ya va elegida. */
	function salidaDe(k: string) {
		if (valores[k] !== undefined) return String(valores[k]);
		const opciones = salidas[k]?.opciones ?? [];
		return opciones.length === 1 ? opciones[0].id : '';
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
		{:else if c['x-salida']}
			{@const sal = salidas[clave]}
			{@const opciones = sal?.opciones ?? []}
			<select id="p-{clave}" name="p.{clave}" value={salidaDe(clave)} required={obligatorio(clave)}>
				<option value="" disabled
					>{opciones.length ? 'Elige una salida' : 'Aún no hay ninguna salida de este tipo'}</option
				>
				{#each opciones as o (o.id)}
					<option value={o.id}
						>{o.nombre}{o.destino ? ` · ${o.destino}` : ''}{o.activa ? '' : ' (en pausa)'}</option
					>
				{/each}
			</select>
			{#if !opciones.length}
				<div class="falta">
					<p>
						Antes de usar esta respuesta hay que configurar el envío por {enFrase(
							sal?.tipoNombre ?? 'este canal'
						)}. Se hace una sola vez, en Avisos y SIEM; al guardarlo, volverás aquí con la salida ya
						seleccionada.
					</p>
					<a
						class="boton principal"
						href="/avisos/nueva?tipo={encodeURIComponent(
							sal?.tipo ?? c['x-salida'].tipo
						)}&volver={encodeURIComponent(page.url.pathname)}">Configurar ahora</a
					>
				</div>
			{/if}
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

	.falta {
		margin: 8px 0 0;
		padding: 9px 12px;
		border-radius: var(--r-sm);
		font-size: 13px;
		background: color-mix(in oklab, var(--warn) 12%, var(--surface));
		color: var(--warn);
	}

	.falta p {
		margin: 0;
	}

	.falta .boton {
		display: inline-block;
		margin-top: 10px;
	}
</style>
