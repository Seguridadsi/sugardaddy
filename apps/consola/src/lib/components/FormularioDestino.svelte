<script lang="ts">
	import {
		EDICIONES,
		POSIX,
		POWERSHELL,
		PROTOCOLOS,
		TIPOS_DESTINO,
		camposDe,
		nombreSo,
		sistemasDe,
		versionesWindows
	} from '$lib/destinos';

	/*
	 * El formulario corto de un destino (docs/diseno/modulo-despliegue.md §5.2):
	 * las preguntas cambian con el tipo y con el sistema. Al crear se elige el
	 * tipo; al editar, no. Lo que ya dice el sensor del destino (bloqueados) se
	 * enseña sin poder cambiarlo. Quien decide es el servidor, que vuelve a
	 * comprobar cada respuesta.
	 */
	type Valores = Record<string, string | string[] | undefined>;
	let {
		tipo: tipoInicial,
		elegirTipo = false,
		valores = {},
		bloqueados = [],
		delSensor = {},
		soSensor,
		direcciones = []
	}: {
		tipo: string;
		elegirTipo?: boolean;
		valores?: Valores;
		bloqueados?: string[];
		delSensor?: Record<string, string>;
		soSensor?: string;
		direcciones?: string[];
	} = $props();

	const texto = (k: string) => {
		const v = valores[k];
		return typeof v === 'string' ? v : '';
	};

	let tipo = $derived(tipoInicial);
	let so = $derived(texto('so'));
	let edicion = $derived(texto('edicion'));

	const campos = $derived(camposDe(tipo));
	const pide = (c: string) => campos.includes(c as never);
	const fijo = (c: string) => bloqueados.includes(c);
	/* El sistema que cuenta: el que dice el sensor o el elegido aquí. */
	const sistema = $derived(fijo('so') ? (soSensor ?? '') : so);
	const marcados = $derived(new Set(Array.isArray(valores.protocolos) ? valores.protocolos : []));
	/* Los detalles finos van en un desplegable: lo único que de verdad se
	 * pregunta es qué sistema es (§5.2). Se abre si ya hay algo que enseñar
	 * (un dato escrito, algo marcado o algo que dice el sensor) o al editar
	 * una ficha, donde se viene a afinar; al añadir uno nuevo, cerrado. */
	const DETALLES = ['edicion', 'version', 'powershell', 'posix', 'direccion', 'nota'] as const;
	const hayDetalle = $derived(
		DETALLES.some((k) => texto(k) || bloqueados.includes(k)) ||
			marcados.size > 0 ||
			bloqueados.includes('protocolos')
	);
	/* Qué detalles tocan según el tipo y el sistema: si ninguno, no hay desplegable. */
	const detallesVisibles = $derived(
		pide('edicion') ||
			(pide('version') && !!sistema) ||
			(pide('powershell') && sistema === 'windows') ||
			(pide('posix') && !!sistema && sistema !== 'windows') ||
			pide('direccion') ||
			pide('protocolos') ||
			pide('nota')
	);
</script>

<div class="campos">
	<div class="ancho">
		<label for="d-nombre">Nombre</label>
		<input
			id="d-nombre"
			name="nombre"
			required
			maxlength="100"
			value={texto('nombre')}
			placeholder="fs01, la impresora de la planta 2…"
		/>
	</div>

	{#if elegirTipo}
		<div class="ancho">
			<label for="d-tipo">Qué es</label>
			<select id="d-tipo" name="tipo" value={tipo} onchange={(e) => (tipo = e.currentTarget.value)}>
				{#each TIPOS_DESTINO as t (t.valor)}
					<option value={t.valor}>{t.texto}</option>
				{/each}
			</select>
		</div>
	{/if}

	{#if pide('so')}
		<div class="ancho">
			<label for="d-so">
				Sistema operativo
				{#if tipo !== 'maquina' && tipo !== 'fileserver'}<small>opcional</small>{/if}
			</label>
			{#if fijo('so')}
				<p class="fijo" id="d-so">
					{nombreSo[delSensor.so ?? ''] ?? delSensor.so} <small>lo dice su sensor</small>
				</p>
			{:else}
				<select
					id="d-so"
					name="so"
					value={so}
					required={tipo === 'maquina' || tipo === 'fileserver'}
					onchange={(e) => (so = e.currentTarget.value)}
				>
					<option value="">Elige uno</option>
					{#each sistemasDe(tipo) as x (x.valor)}
						<option value={x.valor}>{x.texto}</option>
					{/each}
				</select>
			{/if}
		</div>
	{/if}
</div>

{#if detallesVisibles}
	<details class="mas" open={!elegirTipo || hayDetalle}>
		<summary>Más detalles <small>opcional</small></summary>
		<div class="campos">
			{#if pide('edicion')}
				<div>
					<label for="d-edicion">Edición</label>
					<select
						id="d-edicion"
						name="edicion"
						value={edicion}
						onchange={(e) => (edicion = e.currentTarget.value)}
					>
						<option value="">Sin decir</option>
						{#each EDICIONES as x (x.valor)}
							<option value={x.valor}>{x.texto}</option>
						{/each}
					</select>
				</div>
			{/if}

			{#if pide('version') && sistema}
				<div>
					<label for="d-version">Versión</label>
					{#if sistema === 'windows'}
						<select id="d-version" name="version" value={texto('version')}>
							<option value="">Sin decir</option>
							{#each versionesWindows(tipo, edicion) as x (x.valor)}
								<option value={x.valor}>{x.texto}</option>
							{/each}
						</select>
					{:else}
						<input
							id="d-version"
							name="version"
							class="mono"
							inputmode="decimal"
							value={texto('version')}
							placeholder="22.04"
						/>
					{/if}
				</div>
			{/if}

			{#if pide('powershell') && sistema === 'windows'}
				<div>
					<label for="d-powershell">PowerShell</label>
					<select id="d-powershell" name="powershell" value={texto('powershell')}>
						<option value="">Sin decir</option>
						{#each POWERSHELL as x (x.valor)}
							<option value={x.valor}>{x.texto}</option>
						{/each}
					</select>
				</div>
			{/if}

			{#if pide('posix') && sistema && sistema !== 'windows'}
				<div>
					<label for="d-posix">Shell</label>
					<select id="d-posix" name="posix" value={texto('posix')}>
						<option value="">Sin decir</option>
						{#each POSIX as x (x.valor)}
							<option value={x.valor}>{x.texto}</option>
						{/each}
					</select>
				</div>
			{/if}

			{#if pide('direccion')}
				<div class="ancho">
					<label for="d-direccion">Dirección</label>
					<input
						id="d-direccion"
						name="direccion"
						class="mono"
						autocomplete="off"
						list={direcciones.length ? 'd-direcciones' : undefined}
						value={texto('direccion')}
						placeholder="10.20.0.7 o fs01.empresa.local"
					/>
					{#if direcciones.length}
						<datalist id="d-direcciones">
							{#each direcciones as x (x)}<option value={x}></option>{/each}
						</datalist>
					{/if}
					<p class="ayuda">
						La IP o el nombre con que tus equipos llegan a esta máquina. La usan los pasos manuales y
						las pruebas.
					</p>
				</div>
			{/if}

			{#if pide('protocolos')}
				<fieldset class="ancho">
					<legend>Qué comparte</legend>
					{#each PROTOCOLOS as x (x.valor)}
						<label class="marca">
							<input
								type="checkbox"
								name="protocolos"
								value={x.valor}
								checked={marcados.has(x.valor)}
							/>
							{x.texto}
						</label>
					{/each}
				</fieldset>
			{/if}

			{#if pide('nota')}
				<div class="ancho">
					<label for="d-nota">Descripción</label>
					<textarea id="d-nota" name="nota" rows="3" maxlength="500" value={texto('nota')}
					></textarea>
				</div>
			{/if}
		</div>
	</details>
{/if}

<style>
	/* Dos columnas donde caben (Añadir destino) y una en la ficha o en un móvil. */
	.campos {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
		gap: 0 14px;
	}

	.ancho {
		grid-column: 1 / -1;
	}

	/* El desplegable de detalles: un resumen discreto y, abierto, los campos
	 * en la misma rejilla de dos columnas. */
	.mas {
		margin-top: 14px;
	}

	.mas > summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		padding: 6px 0;
	}

	.mas[open] > summary {
		margin-bottom: 8px;
	}

	label small,
	summary small,
	.fijo small {
		font-weight: 400;
		color: var(--ink-3);
		margin-left: 4px;
	}

	.fijo {
		margin: 0;
		padding: 8px 0;
		font-size: 14px;
	}

	.ayuda {
		margin: 5px 0 0;
		font-size: 12.5px;
		color: var(--ink-3);
	}

	fieldset {
		border: none;
		margin: 12px 0 0;
		padding: 0;
		min-width: 0;
	}

	legend {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink-2);
		padding: 0;
		margin-bottom: 5px;
	}

	.marca {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 4px 0;
		font-size: 14px;
		font-weight: 400;
		color: var(--ink);
	}

	.marca input {
		width: auto;
	}
</style>
