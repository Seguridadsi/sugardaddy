<script lang="ts">
	import FormularioParametros from '$lib/components/FormularioParametros.svelte';
	import { ENTORNOS, ENTORNO_ETIQUETA } from '$lib/entorno';
	import { fechaCorta } from '$lib/fechas-pantalla';
	import { nombreAccion } from '$lib/formato';
	import type { EsquemaParametros } from '@sugardaddy/contrato';
	import { untrack, type Snippet } from 'svelte';

	/*
	 * El formulario genérico de una salida (Avisos y SIEM): lo de su canal
	 * (parámetros, pintados desde su esquema como los de un módulo, y
	 * secretos) y lo común (qué envía y cuándo). Un secreto guardado nunca se
	 * vuelve a enseñar: solo si está puesto y, si es largo, cómo acaba. Quien
	 * decide es el servidor, que vuelve a comprobarlo todo.
	 */
	type Canal = {
		tipo: string;
		nombre: string;
		descripcion: string;
		dePrueba?: boolean;
		parametros: EsquemaParametros;
		secretos: readonly {
			id: string;
			titulo: string;
			descripcion: string;
			obligatorio: boolean;
			necesario?: boolean;
			si?: { campo: string; valor: string };
		}[];
	};
	type Reglas = {
		eventos: boolean;
		severidadMinima: string;
		trampas: string[] | null;
		acciones: string[] | null;
		entornos?: string[] | null;
		salud: boolean;
		respuesta?: boolean;
		incidentes?: boolean;
		resumenSemanal?: boolean;
	};
	type Valores = {
		nombre: string;
		activa: boolean;
		configuracion: Record<string, unknown>;
		reglas: Reglas;
		agrupacion: { modo: 'inmediato' } | { modo: 'resumen'; minutos: number };
	};
	type SecretoGuardado = {
		id: string;
		puesto: boolean;
		final: string | null;
		cuando: string | null;
		quien: string | null;
	};

	let {
		canal,
		valores,
		trampas,
		acciones,
		severidades,
		guardados = [],
		claveLista,
		secretoIlegible = null,
		extra,
		parte = 'todo'
	}: {
		/*
		 * Qué parte se ve: el canal (nombre y conexión), qué envía o cuándo. Lo demás
		 * sigue en el formulario, oculto, para que un solo «Save» lo guarde todo.
		 */
		parte?: 'todo' | 'canal' | 'envia' | 'cuando';
		canal: Canal;
		valores: Valores;
		trampas: { id: string; nombre: string }[];
		acciones: readonly string[];
		severidades: readonly string[];
		guardados?: SecretoGuardado[];
		claveLista: boolean;
		secretoIlegible?: string | null;
		/* Algo propio del canal tras sus parámetros (el asistente de Microsoft 365 del correo), según lo elegido. */
		extra?: Snippet<[Record<string, string>]>;
	} = $props();

	/* Lo elegido en los desplegables del canal (su modo): decide qué parámetros y secretos se piden. */
	let elegidos = $state(
		untrack(
			() =>
				Object.fromEntries(
					Object.entries(canal.parametros.properties)
						.filter(([, c]) => (c as { enum?: unknown }).enum)
						.map(([k, c]) => [
							k,
							String(valores.configuracion[k] ?? (c as { default?: unknown }).default ?? '')
						])
				) as Record<string, string>
		)
	);
	/*
	 * Un desplegable que depende de otro (el gestor del ticket, solo por API)
	 * se ve si se ve aquel; lo que cuelga de uno escondido, tampoco se pide.
	 */
	type Condicion = { campo: string; valor: string } | undefined;
	const condicion = (k: string): Condicion =>
		(canal.parametros.properties[k] as { 'x-si'?: Condicion } | undefined)?.['x-si'];
	const cumple = (si: Condicion, vistos: string[] = []): boolean =>
		!si ||
		(elegidos[si.campo] === si.valor &&
			!vistos.includes(si.campo) &&
			cumple(condicion(si.campo), [...vistos, si.campo]));
	const pedidos = $derived(canal.secretos.filter((x) => cumple(x.si)));

	const NOMBRE_SEVERIDAD: Record<string, string> = {
		baja: 'Low: everything',
		media: 'Medium or higher',
		alta: 'High or higher',
		critica: 'Critical only'
	};

	let eventos = $derived(valores.reglas.eventos);
	let trampasModo = $derived(valores.reglas.trampas ? 'algunas' : 'todas');
	let accionesModo = $derived(valores.reglas.acciones ? 'algunas' : 'todas');
	const entornosElegidos = $derived(new Set(valores.reglas.entornos ?? []));
	let agrupacion = $derived(valores.agrupacion.modo);
	const minutos = $derived(valores.agrupacion.modo === 'resumen' ? valores.agrupacion.minutos : 15);
	const elegidas = $derived(new Set(valores.reglas.trampas ?? []));
	const accionesElegidas = $derived(new Set(valores.reglas.acciones ?? []));
	const guardado = (id: string) => guardados.find((g) => g.id === id);
	const ve = (p: 'canal' | 'envia' | 'cuando') => parte === 'todo' || parte === p;
</script>

<div class="parte" hidden={!ve('canal')}>
	<div class="campo">
		<label for="s-nombre">Name</label>
		<input
			id="s-nombre"
			name="nombre"
			required
			maxlength="80"
			value={valores.nombre}
			placeholder="SOC SIEM, on-call email…"
		/>
	</div>

	{#if Object.keys(canal.parametros.properties).length}
		<FormularioParametros
			esquema={canal.parametros}
			valores={valores.configuracion}
			bind:elegidos
		/>
	{/if}
	{@render extra?.(elegidos)}

	{#if pedidos.length}
		<div class="secretos">
			{#if secretoIlegible}
				<p class="aviso" role="alert">{secretoIlegible}</p>
			{/if}
			{#if !claveLista}
				<p class="aviso">
					This node does not have its key for storing secrets yet: it is created when the node is
					updated. Until then, this output cannot store any.
				</p>
			{/if}
			{#each pedidos as x (x.id)}
				{@const g = guardado(x.id)}
				<div class="campo">
					<label for="s-{x.id}">
						{x.titulo}
						{#if !x.obligatorio && !x.necesario}<small>optional</small>{/if}
					</label>
					<input
						id="s-{x.id}"
						name="s.{x.id}"
						type="password"
						class="mono"
						autocomplete="new-password"
						spellcheck="false"
						required={(x.obligatorio || x.necesario) && !g?.puesto}
						placeholder={g?.puesto
							? `Stored${g.final ? `, ends in …${g.final}` : ''}: type a new one to change it`
							: ''}
					/>
					<p class="ayuda">
						{x.descripcion} It is stored encrypted with this node's key and is never shown again.
						{#if g?.puesto && g.cuando}
							Set by {g.quien} on {fechaCorta(g.cuando)}.
						{/if}
					</p>
					{#if g?.puesto && !x.obligatorio && !x.necesario}
						<label class="marca">
							<input type="checkbox" name="s.{x.id}.quitar" />
							Remove it
						</label>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<fieldset hidden={!ve('envia')} class:sola={parte === 'envia'}>
	<legend>What it sends</legend>
	<label class="interruptor">
		<input type="checkbox" name="incidentes" checked={valores.reglas.incidentes !== false} />
		<span>
			<b>Incidents (recommended)</b>
			<small>
				What matters, without the noise: an alert when a source looks like an attack (a honeypot
				that only an attacker would touch, one on the internal network, or many touches within an
				hour), its updates grouped together and a summary when it closes.
			</small>
		</span>
	</label>

	<label class="interruptor">
		<input type="checkbox" name="resumenSemanal" checked={valores.reglas.resumenSemanal === true} />
		<span>
			<b>Weekly summary</b>
			<small>
				On Monday mornings, the week in a few lines: real incidents, what your known sources
				touched, internet noise and pentests. Designed for people (email, Teams, Slack…).
			</small>
		</span>
	</label>

	<label class="interruptor">
		<input
			type="checkbox"
			name="eventos"
			checked={eventos}
			onchange={(e) => (eventos = e.currentTarget.checked)}
		/>
		<span>
			<b>Honeypot events</b>
			<small>Every time someone touches a honeypot, using these filters.</small>
		</span>
	</label>

	<div class="filtros" class:apagado={!eventos}>
		<div class="campo">
			<label for="s-severidad">Minimum severity</label>
			<select id="s-severidad" name="severidad" value={valores.reglas.severidadMinima}>
				{#each severidades as sv (sv)}
					<option value={sv}>{NOMBRE_SEVERIDAD[sv] ?? sv}</option>
				{/each}
			</select>
		</div>

		<div class="grupo">
			<span class="titulo">Which honeypots</span>
			<label class="marca">
				<input
					type="radio"
					name="trampas"
					value="todas"
					checked={trampasModo === 'todas'}
					onchange={() => (trampasModo = 'todas')}
				/>
				All, including honeypots you deploy later
			</label>
			<label class="marca">
				<input
					type="radio"
					name="trampas"
					value="algunas"
					checked={trampasModo === 'algunas'}
					onchange={() => (trampasModo = 'algunas')}
					disabled={!trampas.length}
				/>
				Only some
			</label>
			{#if trampasModo === 'algunas'}
				<div class="lista">
					{#each trampas as t (t.id)}
						<label class="marca">
							<input type="checkbox" name="trampa" value={t.id} checked={elegidas.has(t.id)} />
							{t.nombre}
						</label>
					{/each}
				</div>
			{/if}
		</div>

		<div class="grupo">
			<span class="titulo">Which location</span>
			<p class="nota">
				Where the honeypot is: its own location or, if it has none, that of its sensor. If none is
				ticked, all locations are included.
			</p>
			<div class="en-linea">
				{#each ENTORNOS as e (e)}
					<label class="marca">
						<input type="checkbox" name="entorno" value={e} checked={entornosElegidos.has(e)} />
						{ENTORNO_ETIQUETA[e]}
					</label>
				{/each}
			</div>
		</div>

		<div class="grupo">
			<span class="titulo">Which event type</span>
			<label class="marca">
				<input
					type="radio"
					name="acciones"
					value="todas"
					checked={accionesModo === 'todas'}
					onchange={() => (accionesModo = 'todas')}
				/>
				All
			</label>
			<label class="marca">
				<input
					type="radio"
					name="acciones"
					value="algunas"
					checked={accionesModo === 'algunas'}
					onchange={() => (accionesModo = 'algunas')}
				/>
				Only some
			</label>
			{#if accionesModo === 'algunas'}
				<div class="lista columnas">
					{#each acciones as a (a)}
						<label class="marca">
							<input type="checkbox" name="accion" value={a} checked={accionesElegidas.has(a)} />
							{nombreAccion[a] ?? a}
						</label>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<label class="interruptor">
		<input type="checkbox" name="salud" checked={valores.reglas.salud} />
		<span>
			<b>Node health alerts</b>
			<small>
				A sensor that stops responding, a honeypot that is down or stopped, another output's queue
				being full, and when they recover.
			</small>
		</span>
	</label>

	<label class="interruptor">
		<input type="checkbox" name="respuesta" checked={valores.reglas.respuesta !== false} />
		<span>
			<b>What Response does</b>
			<small>
				Every containment action executed, simulated or failed, what the safeguards do not allow
				and, above all, what is waiting for your approval, with a link to the console.
			</small>
		</span>
	</label>
</fieldset>

<div class="parte" hidden={!ve('cuando')}>
	<fieldset>
		<legend>When</legend>
		<label class="marca">
			<input
				type="radio"
				name="agrupacion"
				value="inmediato"
				checked={agrupacion === 'inmediato'}
				onchange={() => (agrupacion = 'inmediato')}
			/>
			Each one as it happens
		</label>
		<label class="marca resumen">
			<input
				type="radio"
				name="agrupacion"
				value="resumen"
				checked={agrupacion === 'resumen'}
				onchange={() => (agrupacion = 'resumen')}
			/>
			All together, in a digest every
			<input
				class="minutos mono"
				type="number"
				name="minutos"
				min="1"
				max="1440"
				step="1"
				value={minutos}
				aria-label="Minutes between digests"
				class:apagado={agrupacion !== 'resumen'}
			/>
			minutes
		</label>
	</fieldset>

	<label class="interruptor">
		<input type="checkbox" name="activa" checked={valores.activa} />
		<span>
			<b>Enabled</b>
			<small>If you pause it, it stops receiving and anything pending is discarded.</small>
		</span>
	</label>
</div>

<style>
	.parte[hidden],
	fieldset[hidden] {
		display: none;
	}
	.campo {
		margin: 0;
	}

	label small {
		font-weight: 400;
		color: var(--ink-3);
		margin-left: 6px;
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

	fieldset {
		border: none;
		border-top: 1px solid var(--line);
		margin: 22px 0 0;
		padding: 14px 0 0;
		min-width: 0;
	}

	/* Sola en su pestaña, no la separa de nada una línea. */
	fieldset.sola {
		border-top: none;
		margin-top: 0;
		padding-top: 0;
	}

	legend {
		float: left;
		width: 100%;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		padding: 0;
		margin: 0 0 2px;
	}

	.interruptor {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin-top: 14px;
		font-weight: 400;
		color: var(--ink);
		clear: both;
	}

	.interruptor input {
		width: auto;
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.interruptor span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.interruptor b {
		font-size: 13.5px;
	}

	.interruptor small {
		font-size: 12px;
		color: var(--ink-3);
		margin: 0;
	}

	.filtros {
		margin: 4px 0 0 26px;
		display: grid;
		gap: 4px;
	}

	.filtros.apagado {
		opacity: 0.5;
	}

	.grupo {
		margin-top: 12px;
	}

	.titulo {
		display: block;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink-2);
		margin-bottom: 4px;
	}

	.marca {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 5px 0;
		font-size: 14px;
		font-weight: 400;
		color: var(--ink);
		clear: both;
	}

	.marca input {
		width: auto;
		accent-color: var(--accent);
	}

	.lista {
		max-height: 220px;
		overflow-y: auto;
		margin: 4px 0 0 24px;
		padding: 6px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--sunk);
	}

	.nota {
		margin: 0 0 2px;
		font-size: 12px;
		color: var(--ink-3);
	}

	.en-linea {
		display: flex;
		flex-wrap: wrap;
		gap: 0 18px;
	}

	.columnas {
		max-height: none;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 0 12px;
	}

	.resumen {
		flex-wrap: wrap;
	}

	.resumen .minutos {
		width: 84px;
		padding: 5px 8px;
	}

	.resumen .minutos.apagado {
		opacity: 0.5;
	}
</style>
