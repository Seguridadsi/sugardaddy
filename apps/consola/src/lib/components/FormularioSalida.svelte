<script lang="ts">
	import FormularioParametros from '$lib/components/FormularioParametros.svelte';
	import { nombreAccion } from '$lib/formato';
	import type { EsquemaParametros } from '@sugardaddy/contrato';

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
		secretos: readonly { id: string; titulo: string; descripcion: string; obligatorio: boolean }[];
	};
	type Reglas = {
		eventos: boolean;
		severidadMinima: string;
		trampas: string[] | null;
		acciones: string[] | null;
		salud: boolean;
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
		secretoIlegible = null
	}: {
		canal: Canal;
		valores: Valores;
		trampas: { id: string; nombre: string }[];
		acciones: readonly string[];
		severidades: readonly string[];
		guardados?: SecretoGuardado[];
		claveLista: boolean;
		secretoIlegible?: string | null;
	} = $props();

	const NOMBRE_SEVERIDAD: Record<string, string> = {
		baja: 'Baja: todo',
		media: 'Media o más',
		alta: 'Alta o más',
		critica: 'Solo crítica'
	};

	let eventos = $derived(valores.reglas.eventos);
	let trampasModo = $derived(valores.reglas.trampas ? 'algunas' : 'todas');
	let accionesModo = $derived(valores.reglas.acciones ? 'algunas' : 'todas');
	let agrupacion = $derived(valores.agrupacion.modo);
	const minutos = $derived(valores.agrupacion.modo === 'resumen' ? valores.agrupacion.minutos : 15);
	const elegidas = $derived(new Set(valores.reglas.trampas ?? []));
	const accionesElegidas = $derived(new Set(valores.reglas.acciones ?? []));
	const guardado = (id: string) => guardados.find((g) => g.id === id);
	const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-ES');
</script>

<div class="campo">
	<label for="s-nombre">Nombre</label>
	<input
		id="s-nombre"
		name="nombre"
		required
		maxlength="80"
		value={valores.nombre}
		placeholder="SIEM del SOC, correo de guardia…"
	/>
</div>

{#if Object.keys(canal.parametros.properties).length}
	<FormularioParametros esquema={canal.parametros} valores={valores.configuracion} />
{/if}

{#if canal.secretos.length}
	<div class="secretos">
		{#if secretoIlegible}
			<p class="aviso" role="alert">{secretoIlegible}</p>
		{/if}
		{#if !claveLista}
			<p class="aviso">
				Este nodo aún no tiene su clave para guardar secretos: se crea al actualizarlo. Hasta
				entonces, esta salida no puede guardar ninguno.
			</p>
		{/if}
		{#each canal.secretos as x (x.id)}
			{@const g = guardado(x.id)}
			<div class="campo">
				<label for="s-{x.id}">
					{x.titulo}
					{#if !x.obligatorio}<small>opcional</small>{/if}
				</label>
				<input
					id="s-{x.id}"
					name="s.{x.id}"
					type="password"
					class="mono"
					autocomplete="new-password"
					spellcheck="false"
					required={x.obligatorio && !g?.puesto}
					placeholder={g?.puesto
						? `Guardado${g.final ? `, acaba en …${g.final}` : ''}: escribe otro para cambiarlo`
						: ''}
				/>
				<p class="ayuda">
					{x.descripcion} Se guarda cifrado con la clave de este nodo y no se vuelve a enseñar.
					{#if g?.puesto && g.cuando}
						Lo puso {g.quien} el {fecha(g.cuando)}.
					{/if}
				</p>
				{#if g?.puesto && !x.obligatorio}
					<label class="marca">
						<input type="checkbox" name="s.{x.id}.quitar" />
						Quitarlo
					</label>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<fieldset>
	<legend>Qué envía</legend>
	<label class="interruptor">
		<input
			type="checkbox"
			name="eventos"
			checked={eventos}
			onchange={(e) => (eventos = e.currentTarget.checked)}
		/>
		<span>
			<b>Eventos de las trampas</b>
			<small>Cada vez que alguien toca una trampa, con estos filtros.</small>
		</span>
	</label>

	<div class="filtros" class:apagado={!eventos}>
		<div class="campo">
			<label for="s-severidad">Severidad mínima</label>
			<select id="s-severidad" name="severidad" value={valores.reglas.severidadMinima}>
				{#each severidades as sv (sv)}
					<option value={sv}>{NOMBRE_SEVERIDAD[sv] ?? sv}</option>
				{/each}
			</select>
		</div>

		<div class="grupo">
			<span class="titulo">De qué trampas</span>
			<label class="marca">
				<input
					type="radio"
					name="trampas"
					value="todas"
					checked={trampasModo === 'todas'}
					onchange={() => (trampasModo = 'todas')}
				/>
				Todas, también las que pongas después
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
				Solo algunas
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
			<span class="titulo">Qué tipo de evento</span>
			<label class="marca">
				<input
					type="radio"
					name="acciones"
					value="todas"
					checked={accionesModo === 'todas'}
					onchange={() => (accionesModo = 'todas')}
				/>
				Todos
			</label>
			<label class="marca">
				<input
					type="radio"
					name="acciones"
					value="algunas"
					checked={accionesModo === 'algunas'}
					onchange={() => (accionesModo = 'algunas')}
				/>
				Solo algunos
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
			<b>Avisos de salud del nodo</b>
			<small>
				Un sensor que deja de contestar, una trampa caída o parada, la cola de otra salida llena, y
				cuando se arreglan.
			</small>
		</span>
	</label>
</fieldset>

<fieldset>
	<legend>Cuándo</legend>
	<label class="marca">
		<input
			type="radio"
			name="agrupacion"
			value="inmediato"
			checked={agrupacion === 'inmediato'}
			onchange={() => (agrupacion = 'inmediato')}
		/>
		Cada uno en cuanto pasa
	</label>
	<label class="marca resumen">
		<input
			type="radio"
			name="agrupacion"
			value="resumen"
			checked={agrupacion === 'resumen'}
			onchange={() => (agrupacion = 'resumen')}
		/>
		Todo junto, en un resumen cada
		<input
			class="minutos mono"
			type="number"
			name="minutos"
			min="1"
			max="1440"
			step="1"
			value={minutos}
			aria-label="Minutos entre resúmenes"
			class:apagado={agrupacion !== 'resumen'}
		/>
		minutos
	</label>
</fieldset>

<label class="interruptor">
	<input type="checkbox" name="activa" checked={valores.activa} />
	<span>
		<b>Activa</b>
		<small>Si la pausas, deja de recibir y lo que tuviera pendiente se descarta.</small>
	</span>
</label>

<style>
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
