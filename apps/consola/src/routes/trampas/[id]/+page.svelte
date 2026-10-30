<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import EstadoTrampa from '$lib/components/EstadoTrampa.svelte';
	import FormularioParametros from '$lib/components/FormularioParametros.svelte';
	import ListaPasos from '$lib/components/ListaPasos.svelte';
	import { ENTORNOS, ENTORNO_ETIQUETA, ENTORNO_EXPLICACION } from '$lib/entorno';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const e = $derived(data.estado);
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));
	/* Dónde escucha solo tiene sentido si está puesta. */
	const puesta = $derived(e?.estado === 'comprobada' || e?.estado === 'colocada');
	/* Lo que devuelve cada acción: los errores de guardar, o el resultado de un botón. */
	const fallo = $derived(form && 'errores' in form ? form : null);
	const aviso = $derived(form && 'aviso' in form ? form.aviso : null);
	const hecho = $derived(form && 'hecho' in form ? form.hecho : null);
	const avisoPrueba = $derived(form && 'avisoPrueba' in form ? form.avisoPrueba : null);

	const NOMBRES_FORMATO: Record<string, string> = {
		ps1: 'Script de PowerShell (.ps1)',
		sh: 'Script de sh (.sh)',
		md: 'Documento para el control de cambios (.md)',
		txt: 'El mismo documento en texto (.txt)'
	};
	const SCRIPTS = ['ps1', 'sh'];
	const descarga = (formato: string, parte: 'colocar' | 'retirar' = 'colocar') =>
		`${resolve('/trampas/[id]/pasos/[formato]', { id: data.trampa.id, formato })}${parte === 'retirar' ? '?parte=retirar' : ''}`;
	const fecha = (iso: string) =>
		new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeStyle: 'short' }).format(
			new Date(iso)
		);
	const hora = (iso: string) =>
		new Intl.DateTimeFormat('es-ES', { timeStyle: 'short' }).format(new Date(iso));

	/* «Probar» (§8.3): mientras se espera el evento, la página se mira sola cada 10 s. */
	const prueba = $derived(data.prueba);
	const esperando = $derived(prueba.ultima?.estado === 'esperando');
	$effect(() => {
		if (!esperando) return;
		const t = setInterval(() => invalidateAll(), 10_000);
		return () => clearInterval(t);
	});
	const probarScript = (formato: string) =>
		`${resolve('/trampas/[id]/pasos/[formato]', { id: data.trampa.id, formato })}?parte=probar`;
</script>

<svelte:head>
	<title
		>{data.tipo === 'manual' ? 'Pasos de' : 'Ajustes de'} {data.trampa.nombre} — Sugardaddy</title
	>
</svelte:head>

<a class="volver" href={resolve('/trampas')}>← Trampas</a>

{#if data.tipo === 'manual'}
	{@const p = data.pasos}
	{@const destino = data.destino?.nombre ?? p?.destino ?? 'su destino'}
	<div class="cabecera">
		<p class="eyebrow">Pasos a mano · {p?.modulo ?? data.trampa.modulo}</p>
		<h1>{data.trampa.nombre}</h1>
		<p class="desc">
			La pones tú en <b>{destino}</b> con estos pasos: la consola no entra en tus máquinas.
			{#if data.objetivo}Avisa a través de la trampa «{data.objetivo.nombre}».{/if}
		</p>
	</div>
{:else}
	<div class="cabecera">
		<p class="eyebrow">Ajustes · {data.modulo.nombre}</p>
		<h1>{data.trampa.nombre}</h1>
		<p class="desc">
			Al guardar, el sensor rehace la trampa con los ajustes nuevos; sus eventos se conservan.
		</p>
	</div>
{/if}

{#if hecho}<p class="ok" role="status">{hecho}</p>{/if}
{#if aviso}<p class="error" role="alert">{aviso}</p>{/if}

{#if e}
	<!-- Cómo está ahora, como la ve el cliente en las listas (§8.2). -->
	<section class="panel estado" aria-label="Cómo está">
		<p class="linea">
			<EstadoTrampa estado={e} />
			{#if puesta && data.tipo === 'contenedor'}<span class="donde"
					>en <span class="mono">{data.trampa.donde}</span></span
				>{/if}
		</p>
		{#if e.motivo}<p>{e.motivo}</p>{/if}
		{#if e.detalle}<p class="detalle">{e.detalle}</p>{/if}
		{#if e.remedio}<p class="remedio">{e.remedio}</p>{/if}
		{#if e.avisos.length}
			<ul>
				{#each e.avisos as a (a.codigo)}<li>{a.texto}</li>{/each}
			</ul>
		{/if}
	</section>
{/if}

<!--
	Dónde está puesta esta trampa (respuesta por entorno): decide qué respuesta
	tiene sentido si alguien la toca. Hereda de su sensor y se puede afinar aquí
	para este honeypot. Gana lo más específico (lib/entorno.ts).
-->
{#if opera}
	<section class="panel entornobloque" aria-label="Dónde está puesta">
		<h2>Dónde está puesta</h2>
		<p class="ayuda">
			Un señuelo dentro de la red y uno de cara a la web no piden la misma respuesta. Déjalo heredar
			de su sensor o afínalo para este honeypot.
		</p>
		<form method="POST" action="?/entorno" use:enhance>
			<select
				name="entorno"
				aria-label="Entorno de la trampa"
				onchange={(ev) => ev.currentTarget.form?.requestSubmit()}
			>
				<option value="" selected={!data.entorno.propio}
					>Heredar del sensor {data.entorno.sensor
						? `(${ENTORNO_ETIQUETA[data.entorno.sensor]})`
						: '(sin entorno)'}</option
				>
				{#each ENTORNOS as ent (ent)}
					<option value={ent} selected={data.entorno.propio === ent}>{ENTORNO_ETIQUETA[ent]}</option
					>
				{/each}
			</select>
		</form>
		{#if data.entorno.efectivo}
			<p class="explica">{ENTORNO_EXPLICACION[data.entorno.efectivo]}</p>
		{:else}
			<p class="explica sin">
				Sin entorno puesto: el motor se comporta como siempre (no lo frena por ubicación).
			</p>
		{/if}
	</section>
{/if}

<!--
	«Probar» (§8.3): unos pasos que provocan un evento, y la consola espera unos
	minutos a que llegue para darla por comprobada. Lo de una prueba no pasa al
	motor de respuesta ni da alerta.
-->
{#snippet probar(destino: string)}
	{@const como = prueba.como}
	{@const u = prueba.ultima}
	<section id="probar" class="panel bloque probar" aria-label="Probarla">
		<h2>Probarla</h2>
		{#if u?.estado === 'recibida' && u.evento}
			<p class="llegado" role="status">
				Ha llegado el evento de la prueba a las {hora(u.evento.recibido)}{#if u.evento.ip}, desde
					<span class="mono">{u.evento.ip}</span>{/if}: la trampa avisa.
			</p>
		{:else if u?.estado === 'esperando'}
			<p class="esperando" role="status">
				Esperando el evento de la prueba hasta las {hora(u.hasta)}.
				{#if u.ip}Cuenta lo que llegue desde <span class="mono">{u.ip}</span>.{:else}La consola lo
					reconoce por el código de la prueba.{/if}
				Esta página lo dirá en cuanto llegue.
			</p>
			{#if u.pasos?.forma === 'generica'}
				<p>
					Desde otro equipo de la red, conéctate a <span class="mono">{u.pasos.direccion}</span>,
					puerto
					{u.pasos.puerto}. Basta con que la conexión llegue.
				</p>
				<p class="ayuda">En Windows, con PowerShell:</p>
				<pre class="mono codigo">{u.pasos.windows}</pre>
				<p class="ayuda">En Linux o macOS:</p>
				<pre class="mono codigo">{u.pasos.linux}</pre>
			{:else if u.pasos?.forma === 'via'}
				<ListaPasos pasos={u.pasos.pasos} lenguaje="ninguno" />
				{#if u.pasos.variables.length}
					<dl class="datos">
						{#each u.pasos.variables as [k, v] (k)}<dt class="mono">{k}</dt>
							<dd>{v}</dd>{/each}
					</dl>
				{/if}
			{:else if u.pasos?.forma === 'destino'}
				<p>
					Ejecuta en <b>{destino}</b> el script de la prueba: primero comprueba que desde ahí se llega
					a la trampa a la que apunta, y después usa lo que pusiste con el código de esta prueba.
				</p>
				{#if opera}
					<div class="descargas">
						{#each u.pasos.formatos.filter((f) => SCRIPTS.includes(f)) as f (f)}
							<a class="boton principal" href={probarScript(f)} download
								>{NOMBRES_FORMATO[f]} de la prueba</a
							>
						{/each}
					</div>
				{/if}
				{#if u.pasos.lenguaje !== 'ninguno'}
					<p class="ayuda">Si la haces a mano, copia esto primero:</p>
					<pre class="mono codigo">{u.pasos.bloque}</pre>
				{/if}
				<ListaPasos pasos={u.pasos.pasos} lenguaje={u.pasos.lenguaje} />
			{/if}
		{:else if u?.estado === 'caducada'}
			<p class="caducada">
				La última prueba, hasta las {hora(u.hasta)}, no recibió nada. Revisa que la trampa se ve
				desde donde probaste y vuelve a probar.
			</p>
		{/if}

		{#if avisoPrueba}<p class="error" role="alert">{avisoPrueba}</p>{/if}
		{#if como.puede}
			{#if !u}
				<p>
					{#if como.forma === 'generica'}
						Te dirá cómo conectarte a uno de sus puertos desde otro equipo.
					{:else if como.forma === 'destino'}
						Te dará un script para ejecutar en {destino}, con un código propio.
					{:else}
						Te dará unos pasos con un código propio.
					{/if}
					La consola esperará {como.ventanaMin} minutos a que llegue el evento. Lo de la prueba se ve
					con la etiqueta «prueba» y no da alertas.
				</p>
			{/if}
			{#if opera}
				<form method="POST" action="?/probar" class="form-probar" use:enhance>
					{#if como.porIp === 'pedir'}
						<label for="ip-prueba">IP del equipo desde el que vas a probar</label>
						<input
							id="ip-prueba"
							name="ip"
							class="mono"
							inputmode="decimal"
							autocomplete="off"
							value={(form && 'ip' in form ? form.ip : null) ?? prueba.ipNavegador ?? ''}
						/>
						<p class="ayuda">
							Sin una marca propia, la consola reconoce la prueba por esta IP. Es la de este
							navegador tal como la ve la consola: cámbiala si vas a probar desde otro equipo.
						</p>
					{:else if como.porIp === 'destino' && como.ip}
						<p class="ayuda">
							Cuenta lo que llegue desde {destino} (<span class="mono">{como.ip}</span>).
						</p>
					{/if}
					<button class="boton" class:principal={!esperando}
						>{u ? 'Probar otra vez' : 'Probar'}</button
					>
				</form>
			{/if}
		{:else}
			<p class="ayuda">
				{como.motivo}
				{#if como.destino}<a href={resolve('/destinos/[id]', { id: como.destino })}>Ir al destino</a
					>{/if}
			</p>
		{/if}
	</section>
{/snippet}

{#if data.tipo === 'contenedor'}
	{@render probar(data.trampa.sensor)}
{/if}

{#if data.tipo === 'manual'}
	{@const p = data.pasos}
	{@const destino = data.destino?.nombre ?? p?.destino ?? 'su destino'}
	{@const colocacion = data.trampa.colocacion}
	{#if p}
		<!-- Qué toca hacer ahora, según cómo está. -->
		<section class="panel ahora" aria-label="Qué hacer ahora">
			{#if colocacion === 'retirando'}
				<h2>Quítala de {destino}</h2>
				<p>
					Sigue los pasos para quitarla (abajo, o con el script) y, cuando no quede nada en {destino},
					pulsa «Ya lo he quitado». Hasta entonces sigue avisando si alguien usa lo que pusiste.
				</p>
			{:else if colocacion === 'por-colocar'}
				<h2>Ponla en {destino}</h2>
				<ol class="como">
					<li>
						Ejecuta el script en {destino}, o copia el bloque de variables y sigue los pasos uno a
						uno.
					</li>
					<li>Cuando estén hechos, pulsa «Ya está hecho».</li>
				</ol>
			{:else}
				<h2>Está puesta en {destino}</h2>
				<p>
					Para quitarla, pulsa «Retirar»: te dará los pasos para dejar {destino} como estaba. Una trampa
					puesta a mano no se cambia: se retira y se pone otra.
				</p>
			{/if}
			{#if p.marca}
				<p class="ayuda">
					Su señal: un evento de «{data.objetivo?.nombre ?? 'la trampa a la que apunta'}» con {p.marca}.
				</p>
			{/if}
			{#if !p.integros}
				<p class="error" role="alert">
					Los pasos guardados ya no cuadran con su huella, así que no se descargan. Avisa a
					SeguridadSI.
				</p>
			{:else if opera}
				<div class="descargas">
					{#each p.formatos as f (f)}
						<a
							class="boton"
							href={descarga(f, colocacion === 'retirando' ? 'retirar' : 'colocar')}
							download
							>{SCRIPTS.includes(f) && colocacion === 'retirando'
								? `${NOMBRES_FORMATO[f]} para quitarla`
								: NOMBRES_FORMATO[f]}</a
						>
					{/each}
				</div>
			{/if}
			{#if opera}
				<div class="botones">
					{#if colocacion === 'por-colocar'}
						<form method="POST" action="?/hecho" use:enhance>
							<button class="boton principal">Ya está hecho</button>
						</form>
						<!-- Lo que apuntaba ha cambiado y aún no está puesta: se preparan otra vez (§8.2). -->
						{#if data.cambiar && e?.avisos.some((a) => a.codigo.startsWith('senal.objetivo-'))}
							<form method="POST" action="?/regenerar" use:enhance>
								<button class="boton">Volver a generar los pasos</button>
							</form>
						{/if}
					{/if}
					{#if colocacion === 'retirando'}
						<form method="POST" action="?/quitado" use:enhance>
							<button class="boton principal">Ya lo he quitado</button>
						</form>
					{:else}
						<form method="POST" action="?/retirar" use:enhance>
							<button class="boton peligro">Retirar</button>
						</form>
					{/if}
				</div>
			{/if}
		</section>

		{#if colocacion !== 'por-colocar' && colocacion !== 'retirando'}
			{@render probar(destino)}
		{/if}

		{#if p.lenguaje !== 'ninguno'}
			<section class="panel bloque" aria-label="Variables">
				<h2>Variables</h2>
				<p class="ayuda">
					Copia esto primero si sigues los pasos a mano: las órdenes usan estos valores. El script
					ya lo lleva al principio.
				</p>
				<pre class="mono codigo">{p.bloque}</pre>
			</section>
		{:else if p.variables.length}
			<section class="panel bloque" aria-label="Datos">
				<h2>Datos</h2>
				<dl class="datos">
					{#each p.variables as [k, v] (k)}<dt class="mono">{k}</dt>
						<dd>{v}</dd>{/each}
				</dl>
			</section>
		{/if}

		{#if colocacion === 'retirando'}
			<section class="panel bloque">
				<h2>Pasos para quitarla</h2>
				<ListaPasos pasos={p.retirada} lenguaje={p.lenguaje} />
			</section>
			<details class="panel bloque">
				<summary>Pasos con que se puso</summary>
				<ListaPasos pasos={p.pasos} lenguaje={p.lenguaje} />
			</details>
		{:else}
			<section class="panel bloque">
				<h2>Pasos para ponerla</h2>
				<ListaPasos pasos={p.pasos} lenguaje={p.lenguaje} />
			</section>
			<details class="panel bloque">
				<summary>Pasos para quitarla</summary>
				<ListaPasos pasos={p.retirada} lenguaje={p.lenguaje} />
			</details>
		{/if}

		{#if data.cambiar && opera}
			<!-- Mientras no está puesta, sus datos se cambian y los pasos se preparan otra vez (§6.3). -->
			<details class="panel bloque" open={!!fallo}>
				<summary>Cambiar sus datos</summary>
				<form method="POST" action="?/guardar" class="cambiar" use:enhance>
					{#if fallo?.errores?.length || fallo?.motivos?.length}
						<ul class="errores" role="alert">
							{#each fallo.errores as x (x)}<li>{x}</li>{/each}
							{#each fallo.motivos as x (x.codigo + x.texto)}
								<li>
									{x.texto}
									{#if x.remedio}<span class="remedio">{x.remedio}</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}
					<label for="nombre">Nombre visible</label>
					<input id="nombre" name="nombre" required value={fallo?.nombre ?? data.trampa.nombre} />
					<FormularioParametros
						esquema={data.cambiar.parametros}
						valores={fallo?.valores ?? data.cambiar.valores}
						objetivos={data.cambiar.objetivos}
					/>
					<p class="ayuda">
						Si ya habías empezado con los pasos de antes, quita primero lo que pusiste con sus pasos
						para quitarla.
					</p>
					<button class="boton principal enviar">Guardar y preparar los pasos de nuevo</button>
				</form>
			</details>
		{/if}

		<p class="huella">
			Generados el {fecha(p.generado)} con {p.modulo}
			{p.versionModulo} · {p.via} · sha256 <span class="mono">{p.sha256}</span>
		</p>
	{:else}
		<section class="panel bloque">
			<p>Esta trampa no tiene pasos guardados: retírala y vuelve a ponerla.</p>
		</section>
	{/if}
{:else}
	{#if data.avisos.length}
		<!-- Lo que dice hoy el elector de su máquina: no impide guardar, esté como esté la trampa. -->
		<section class="panel avisos" aria-label="Avisos">
			<p class="intro-avisos">Avisos de su máquina. No impiden guardar los cambios.</p>
			<ul>
				{#each data.avisos as a (a.codigo + a.texto)}
					<li>
						{a.texto}
						{#if a.remedio}<span class="remedio">{a.remedio}</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<form class="panel formulario" method="POST" action="?/guardar" use:enhance>
		{#if fallo?.errores?.length || fallo?.motivos?.length}
			<ul class="errores" role="alert">
				{#each fallo.errores as e (e)}<li>{e}</li>{/each}
				{#each fallo.motivos as x (x.codigo + x.texto)}
					<li>
						{x.texto}
						{#if x.remedio}<span class="remedio">{x.remedio}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<label for="nombre">Nombre visible</label>
		<input id="nombre" name="nombre" required value={fallo?.nombre ?? data.trampa.nombre} />

		<h2>Parámetros del módulo</h2>
		<FormularioParametros
			esquema={data.modulo.parametros}
			valores={fallo?.valores ?? data.valores}
		/>

		<button class="boton principal enviar">Guardar y aplicar</button>
	</form>
{/if}

<style>
	.volver {
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.cabecera {
		margin: 14px 0 20px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.desc {
		max-width: 70ch;
		color: var(--ink-2);
		margin: 6px 0 0;
	}

	.estado {
		max-width: 720px;
		margin: 0 0 16px;
		padding: 12px 18px;
		font-size: 13.5px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.estado p {
		margin: 4px 0;
	}

	.estado .linea {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 8px;
	}

	.estado .donde {
		font-size: 12.5px;
	}

	.estado .detalle {
		font-size: 12.5px;
		color: var(--ink-3);
	}

	.estado ul {
		margin: 6px 0 2px;
		padding-left: 18px;
		font-size: 12.5px;
	}

	.formulario {
		max-width: 720px;
		padding: 18px 20px 22px;
	}

	.avisos {
		max-width: 720px;
		margin: 0 0 16px;
		padding: 4px 18px;
		border-color: var(--warn);
	}

	.intro-avisos {
		margin: 10px 0 2px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--warn);
	}

	.avisos ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.avisos li {
		padding: 10px 0 10px 12px;
		border-bottom: 1px solid var(--line);
		box-shadow: inset 3px 0 0 var(--warn);
		font-size: 13px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.avisos li:last-child {
		border-bottom: none;
	}

	.remedio {
		display: block;
		margin-top: 3px;
		color: var(--ink);
	}

	h2 {
		font-size: 15px;
		font-weight: 600;
		margin: 22px 0 2px;
	}

	.errores {
		margin: 0 0 14px;
		padding: 10px 14px 10px 30px;
		border-radius: var(--r-sm);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
		color: var(--crit);
		font-size: 13px;
		overflow-wrap: anywhere;
	}

	.enviar {
		margin-top: 22px;
	}

	.ok,
	.error {
		max-width: 720px;
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
		overflow-wrap: anywhere;
	}

	.ok {
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
		border: 1px solid color-mix(in oklab, var(--crit) 40%, var(--line));
	}

	.ahora,
	.bloque {
		max-width: 720px;
		margin: 0 0 16px;
		padding: 16px 18px 18px;
		min-width: 0;
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.ahora h2,
	.bloque h2 {
		margin-top: 0;
		color: var(--ink);
	}

	.ahora p {
		margin: 6px 0 0;
		overflow-wrap: anywhere;
	}

	.ahora .error {
		margin: 12px 0 0;
	}

	.como {
		margin: 6px 0 0;
		padding-left: 20px;
	}

	.ayuda {
		margin: 6px 0 0;
		font-size: 12.5px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.descargas,
	.botones {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 14px;
	}

	.botones form {
		margin: 0;
	}

	details.bloque summary {
		cursor: pointer;
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
	}

	.codigo {
		margin: 8px 0 0;
		padding: 10px 12px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		font-size: 12px;
		line-height: 1.5;
		overflow-x: auto;
		white-space: pre;
		color: var(--ink);
	}

	.datos {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 4px 12px;
		margin: 8px 0 0;
	}

	.datos dd {
		margin: 0;
		overflow-wrap: anywhere;
		color: var(--ink);
	}

	.cambiar .errores {
		margin-top: 12px;
	}

	.probar p {
		margin: 6px 0 0;
		overflow-wrap: anywhere;
	}

	.probar .llegado,
	.probar .esperando,
	.probar .caducada {
		margin: 4px 0 10px;
		padding: 9px 12px;
		border-radius: var(--r-sm);
		color: var(--ink);
	}

	.probar .llegado {
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
	}

	.probar .esperando {
		background: color-mix(in oklab, var(--accent) 10%, var(--surface));
	}

	.probar .caducada {
		background: color-mix(in oklab, var(--warn) 12%, var(--surface));
	}

	.form-probar {
		margin-top: 12px;
	}

	.form-probar label {
		display: block;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
		margin-bottom: 4px;
	}

	.form-probar input {
		width: 100%;
		max-width: 320px;
	}

	.form-probar button {
		margin-top: 12px;
	}

	.huella {
		max-width: 720px;
		margin: 0 0 16px;
		font-size: 12px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.entornobloque {
		max-width: 720px;
		margin: 0 0 16px;
		padding: 14px 18px 16px;
		font-size: 13.5px;
		color: var(--ink-2);
	}

	.entornobloque h2 {
		margin: 0 0 2px;
		color: var(--ink);
	}

	.entornobloque form {
		margin: 10px 0 0;
	}

	.entornobloque select {
		max-width: 320px;
	}

	.explica {
		margin: 10px 0 0;
		font-size: 12.5px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.explica.sin {
		font-style: italic;
	}
</style>
