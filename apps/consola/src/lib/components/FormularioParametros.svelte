<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
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
		/* Un HTML: además de pegarlo, se puede subir de un fichero o clonar de una dirección. */
		'x-html'?: boolean;
		maxLength?: number;
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
		/* Su valor por defecto depende de lo elegido en otro desplegable (el puerto según el producto). */
		'x-segun'?: { campo: string; valores: Record<string, unknown> };
	};
	/* Una trampa a la que puede apuntar un parámetro x-trampa; con motivo, no se puede elegir. */
	type Objetivo = { id: string; nombre: string; destino: string; motivo: string | null };

	let {
		esquema,
		valores = {},
		objetivos = {},
		elegidos = $bindable(),
		prefijo = 'p'
	}: {
		esquema: EsquemaParametros;
		valores?: Record<string, unknown>;
		/* Las opciones de cada parámetro x-trampa, que calcula el servidor. */
		objetivos?: Record<string, Objetivo[]>;
		/* Lo elegido ahora en cada desplegable (para x-si); quien lo enlaza lo ve cambiar. */
		elegidos?: Record<string, string>;
		/*
		 * Con qué empiezan el nombre y el id de cada campo («p.puerto», «p-puerto»).
		 * Otro prefijo deja poner varios formularios en la misma página sin que
		 * choquen: el constructor de plantillas pinta uno por honeypot.
		 */
		prefijo?: string;
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
	/*
	 * x-segun: el valor por defecto de un campo según lo elegido en otro. Al
	 * cambiar aquel, el campo sigue al nuevo default si aún tenía el del
	 * anterior; si quien despliega escribió otro, se queda el suyo.
	 */
	const defaultSegun = (c: Campo, opcion: string | undefined) => {
		const xs = c['x-segun'];
		return String(
			(xs && opcion !== undefined && Object.hasOwn(xs.valores, opcion)
				? xs.valores[opcion]
				: null) ??
				c.default ??
				''
		);
	};
	let segun = $state<Record<string, string>>(
		untrack(() =>
			Object.fromEntries(
				(Object.entries(esquema.properties) as [string, Campo][])
					.filter(([, c]) => c['x-segun'])
					.map(([k, c]) => {
						const de = c['x-segun']!.campo;
						const elegido = elegidos?.[de] ?? valor(de, esquema.properties[de] as Campo);
						return [k, valores[k] !== undefined ? String(valores[k]) : defaultSegun(c, elegido)];
					})
			)
		)
	);
	function elegir(clave: string, nuevo: string) {
		const antes = elegidos?.[clave];
		for (const [k, c] of campos)
			if (c['x-segun']?.campo === clave && segun[k] === defaultSegun(c, antes))
				segun[k] = defaultSegun(c, nuevo);
		elegidos = { ...elegidos, [clave]: nuevo };
	}
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
	/*
	 * x-html: el HTML se puede subir de un fichero (se lee aquí, en el
	 * navegador) o clonar de una dirección (lo baja la consola, con sus
	 * guardas). Las dos cosas solo rellenan el cuadro: quien despliega lo ve,
	 * lo retoca y lo guarda con el resto del formulario.
	 */
	let html = $state<Record<string, string>>(
		untrack(() =>
			Object.fromEntries(
				(Object.entries(esquema.properties) as [string, Campo][])
					.filter(([, c]) => c['x-html'])
					.map(([k, c]) => [k, valor(k, c)])
			)
		)
	);
	let clon = $state<Record<string, { url: string; ocupado: boolean; aviso: string; mal: boolean }>>(
		{}
	);
	const estadoClon = (k: string) => clon[k] ?? { url: '', ocupado: false, aviso: '', mal: false };
	const kb = (n: number) => `${Math.ceil(n / 1000)} KB`;
	async function subirHtml(k: string, c: Campo, e: Event & { currentTarget: HTMLInputElement }) {
		const fichero = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!fichero) return;
		const max = c.maxLength ?? Infinity;
		const texto = fichero.size > max * 4 ? null : await fichero.text();
		if (texto === null || texto.length > max) {
			clon[k] = {
				...estadoClon(k),
				mal: true,
				aviso: `${fichero.name} is larger than the ${kb(max)} the decoy holds`
			};
			return;
		}
		html[k] = texto;
		clon[k] = {
			...estadoClon(k),
			mal: false,
			aviso: `${fichero.name} loaded (${kb(texto.length)})`
		};
	}
	async function clonarHtml(k: string) {
		const url = estadoClon(k).url.trim();
		if (!url) return;
		clon[k] = { url, ocupado: true, aviso: '', mal: false };
		try {
			const r = await fetch(resolve('/decoys/clone'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url })
			});
			const d = (await r.json()) as { html?: string; error?: string };
			if (!r.ok || typeof d.html !== 'string')
				throw new Error(d.error ?? 'Could not clone the page');
			html[k] = d.html;
			clon[k] = {
				url,
				ocupado: false,
				mal: false,
				aviso: `Page cloned (${kb(d.html.length)}). Review it before saving.`
			};
		} catch (err) {
			clon[k] = { url, ocupado: false, mal: true, aviso: (err as Error).message };
		}
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
					id="{prefijo}-{clave}"
					name="{prefijo}.{clave}"
					type="checkbox"
					value="true"
					checked={valor(clave, c) === 'true'}
				/>
				{c.title ?? clave}
			</label>
		{:else}
			<label for="{prefijo}-{clave}">
				{c.title ?? clave}
				{#if !obligatorio(clave)}<small>optional</small>{/if}
			</label>
		{/if}
		{#if c['x-casilla']}
			<!-- ya pintada arriba -->
		{:else if c['x-trampa']}
			{@const opciones = objetivos[clave] ?? []}
			<select
				id="{prefijo}-{clave}"
				name="{prefijo}.{clave}"
				value={objetivoDe(clave)}
				required={obligatorio(clave)}
			>
				<option value="" disabled
					>{opciones.length ? 'Choose a honeypot' : 'You have no honeypots of this type'}</option
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
				id="{prefijo}-{clave}"
				name="{prefijo}.{clave}"
				value={elegidos?.[clave] ?? valor(clave, c)}
				onchange={(e) => elegir(clave, e.currentTarget.value)}
			>
				{#each c.enum as op (op)}
					<option value={op}>{c['x-opciones']?.[op] ?? op}</option>
				{/each}
			</select>
		{:else if c.type === 'integer' || c.type === 'number'}
			<input
				id="{prefijo}-{clave}"
				name="{prefijo}.{clave}"
				type="number"
				step={c.type === 'integer' ? 1 : 'any'}
				min={c.minimum}
				max={c.maximum}
				value={c['x-segun'] ? segun[clave] : valor(clave, c)}
				oninput={c['x-segun']
					? (e: Event & { currentTarget: HTMLInputElement }) =>
							(segun[clave] = e.currentTarget.value)
					: undefined}
				required={obligatorio(clave)}
				class="mono"
			/>
		{:else if c.type === 'boolean'}
			<select id="{prefijo}-{clave}" name="{prefijo}.{clave}" value={valor(clave, c) || 'false'}>
				<option value="true">Yes</option>
				<option value="false">No</option>
			</select>
		{:else if c['x-html']}
			{@const ec = estadoClon(clave)}
			<div class="html-origen">
				<label class="subir">
					Upload an HTML file
					<input
						type="file"
						accept=".html,.htm,text/html"
						onchange={(e) => subirHtml(clave, c, e)}
					/>
				</label>
				<span class="o">or</span>
				<input
					type="url"
					class="mono"
					placeholder="https://intranet.example.com/login"
					aria-label="Address of the page to clone"
					value={ec.url}
					oninput={(e) => (clon[clave] = { ...ec, url: e.currentTarget.value })}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							clonarHtml(clave);
						}
					}}
				/>
				<button
					type="button"
					class="boton"
					disabled={ec.ocupado || !ec.url.trim()}
					onclick={() => clonarHtml(clave)}>{ec.ocupado ? 'Cloning…' : 'Clone page'}</button
				>
			</div>
			{#if ec.aviso}<p class="ayuda" class:mal={ec.mal} role="status">{ec.aviso}</p>{/if}
			<textarea
				id="{prefijo}-{clave}"
				name="{prefijo}.{clave}"
				rows="10"
				maxlength={c.maxLength}
				required={obligatorio(clave)}
				class="mono"
				spellcheck="false"
				bind:value={html[clave]}></textarea>
		{:else if c['x-multilinea']}
			<textarea
				id="{prefijo}-{clave}"
				name="{prefijo}.{clave}"
				rows="6"
				required={obligatorio(clave)}
				class="mono"
				spellcheck="false">{valor(clave, c)}</textarea
			>
		{:else}
			<input
				id="{prefijo}-{clave}"
				name="{prefijo}.{clave}"
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

	.html-origen {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.html-origen input[type='url'] {
		flex: 1 1 240px;
		min-width: 0;
	}

	.html-origen .o {
		font-size: 12px;
		color: var(--ink-3);
	}

	.subir {
		font-weight: 400;
		font-size: 13px;
	}

	.subir input {
		display: block;
		margin-top: 4px;
		font-size: 12px;
	}

	.ayuda.mal {
		color: var(--crit);
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
