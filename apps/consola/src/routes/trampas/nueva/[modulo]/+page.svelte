<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import FormularioParametros from '$lib/components/FormularioParametros.svelte';
	import { nombreTipoDestino } from '$lib/destinos';
	import { enFrase, nombreTipo } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const m = $derived(data.modulo);
	const f = $derived(data.forma);
	const opera = $derived(puede(page.data.usuario?.roles ?? [], 'desplegar'));
	const aqui = $derived(resolve('/trampas/nueva/[modulo]', { modulo: m.id }));
	/* El formulario de un destino, con otra forma si el cliente la elige. */
	const en = (destino: string, via?: string) =>
		`${aqui}?${new URLSearchParams({ destino, ...(via ? { via } : {}) })}`;
	const valen = $derived(data.donde?.filter((d) => d.elegida && !d.bloqueo).length ?? 0);
	const elegida = $derived(f?.eleccion.elegida ?? null);
	const otras = $derived(f && elegida ? f.eleccion.vias.filter((v) => v.via !== elegida.via) : []);
	const plataforma = (p: string | null) => p ?? 'sin datos de su sistema';
</script>

<svelte:head>
	<title>Desplegar {m.nombre} — Sugardaddy</title>
</svelte:head>

{#if f}
	<a class="volver" href={aqui}>← Elegir otro destino</a>
{:else}
	<a class="volver" href={resolve('/trampas')}>← Trampas</a>
{/if}

<div class="cabecera">
	<p class="eyebrow">Desplegar · {nombreTipo[m.tipo]}</p>
	<h1>{m.nombre}</h1>
	<p class="desc">{m.descripcion}</p>
</div>

{#if data.donde}
	<section class="panel bloque">
		<h2>¿Dónde la pones?</h2>
		{#if data.donde.length}
			<p class="ayuda">
				{valen === 0
					? 'Ahora no vale en ninguno de tus destinos.'
					: `Vale en ${valen} de tus ${data.donde.length} destinos.`}
				Se mira con sus ajustes de serie: al ponerla puedes cambiarlos.
			</p>
			<ul class="destinos">
				{#each data.donde as d (d.id)}
					<li class:vale={d.elegida && !d.bloqueo}>
						<div class="quien">
							<a class="nombre" href={en(d.id)}>{d.nombre}</a>
							<small>
								{nombreTipoDestino(d.tipo)} · {plataforma(d.plataforma)} ·
								{d.sensor ? `sensor ${d.sensor.nombre}` : 'sin sensor'}
							</small>
						</div>
						<div class="resultado">
							{#if d.elegida && !d.bloqueo}
								<p class="si">Vale: {enFrase(d.elegida.nombre)}</p>
							{:else if d.elegida}
								<p class="espera">Ahora no se puede</p>
								<p class="motivo">{d.bloqueo}</p>
							{:else}
								<p class="no">No vale aquí</p>
							{/if}
							{#if d.motivo}
								<p class="motivo">{d.motivo.texto}</p>
								{#if d.motivo.remedio}<p class="remedio">{d.motivo.remedio}</p>{/if}
							{/if}
							{#each d.elegida?.avisos ?? [] as a (a.codigo + a.texto)}
								<p class="aviso-via">{a.texto}</p>
							{/each}
						</div>
						<a class="boton" class:principal={d.elegida && !d.bloqueo} href={en(d.id)}
							>{!d.elegida || d.bloqueo ? 'Ver por qué' : 'Ponerla aquí'}</a
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="ayuda">
				Aún no tienes ningún destino. Cada sensor trae el suyo: aparece en cuanto des de alta uno.
			</p>
		{/if}
		{#if opera}
			<p class="mas">
				¿No está donde la quieres poner? <a href={resolve('/destinos/nuevo')}>Añade un destino</a>.
			</p>
		{/if}
	</section>
{:else if f}
	<p class="donde">
		En <b>{f.destino.nombre}</b> · {nombreTipoDestino(f.destino.tipo)} · {plataforma(
			f.destino.plataforma
		)} · {f.destino.sensor ? `sensor ${f.destino.sensor.nombre}` : 'sin sensor'}
	</p>

	<div class="rejilla" class:sola={!f.manifiesto && !f.pasos}>
		<div class="principal">
			{#if elegida && !f.bloqueo}
				<form class="panel formulario" method="POST">
					{#if form?.errores?.length || form?.motivos?.length}
						<ul class="errores" role="alert">
							{#each form.errores as e (e)}<li>{e}</li>{/each}
							{#each form.motivos as x (x.codigo + x.texto)}
								<li>
									{x.texto}
									{#if x.remedio}<span class="remedio-error">{x.remedio}</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}
					<input type="hidden" name="destino" value={f.destino.id} />
					<input type="hidden" name="via" value={elegida.via} />

					<h2>Cómo</h2>
					<p class="via">{elegida.nombre}</p>
					{#each elegida.avisos as a (a.codigo + a.texto)}
						<p class="aviso-via">{a.texto}</p>
					{/each}

					<label for="id">Identificador</label>
					<input
						id="id"
						name="id"
						required
						class="mono"
						value={form?.id ?? ''}
						placeholder="ssh-fs02"
					/>

					<label for="nombre">Nombre visible</label>
					<input
						id="nombre"
						name="nombre"
						required
						value={form?.nombre ?? ''}
						placeholder="srv-fs02"
					/>

					<h2>Parámetros del módulo</h2>
					<FormularioParametros
						esquema={m.parametros}
						valores={form?.valores}
						objetivos={f.objetivos}
						sugerencias={f.sugerencias}
					/>

					{#if f.pasos}
						<p class="ayuda">
							Al guardar, la consola prepara los pasos con estos datos y los de {f.destino.nombre}.
							Los haces tú: la consola no entra en tus máquinas.
						</p>
						<button class="boton principal enviar"
							>Preparar los pasos para {f.destino.nombre}</button
						>
					{:else}
						<button class="boton principal enviar">Desplegar en {f.destino.nombre}</button>
					{/if}
				</form>
			{:else if elegida}
				<section class="panel bloque">
					<h2>{elegida.nombre}</h2>
					<p class="nota">{f.bloqueo}</p>
				</section>
			{:else}
				<section class="panel bloque">
					<h2>No vale en {f.destino.nombre}</h2>
					{#if f.eleccion.vias.length === 0 && f.eleccion.motivo}
						<p class="motivo">{f.eleccion.motivo.texto}</p>
					{/if}
					<ul class="vias">
						{#each f.eleccion.vias as v (v.via)}
							<li>
								{#if f.eleccion.vias.length > 1}<p><b>{v.nombre}</b></p>{/if}
								{#each v.motivos as x (x.codigo + x.texto)}
									<p>
										{x.texto}
										<small class="mono" title="Código para soporte">{x.codigo}</small>
									</p>
									{#if x.remedio}<p class="remedio">{x.remedio}</p>{/if}
								{/each}
							</li>
						{/each}
					</ul>
					<p class="mas"><a href={aqui}>Elige otro destino</a></p>
				</section>
			{/if}

			{#if otras.length}
				<section class="panel bloque">
					<h2>
						{otras.some((v) => v.vale) ? 'Otras formas' : 'Otras formas y por qué no valen aquí'}
					</h2>
					<ul class="vias">
						{#each otras as v (v.via)}
							<li>
								<p>
									<b>{v.nombre}</b>
									<span class={v.vale ? 'si' : 'no'}>{v.vale ? 'vale' : 'no vale aquí'}</span>
								</p>
								{#each v.motivos as x (x.codigo + x.texto)}
									<p>
										{x.texto}
										<small class="mono" title="Código para soporte">{x.codigo}</small>
									</p>
									{#if x.remedio}<p class="remedio">{x.remedio}</p>{/if}
								{/each}
								{#each v.avisos as x (x.codigo + x.texto)}
									<p class="aviso-via">{x.texto}</p>
								{/each}
								{#if v.vale}<p><a href={en(f.destino.id, v.via)}>Ponerla así</a></p>{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>

		{#if f.pasos}
			<!-- Una forma a mano: lo que harás en el destino, antes de rellenar nada. -->
			<aside class="panel ficha">
				<h2>Qué harás en {f.destino.nombre}</h2>
				<ol class="pasos">
					{#each f.pasos.pasos as paso, i (i)}<li>{paso}</li>{/each}
				</ol>
				{#if f.pasos.retirada.length}
					<p class="eyebrow">Para quitarla</p>
					<ol class="pasos">
						{#each f.pasos.retirada as paso, i (i)}<li>{paso}</li>{/each}
					</ol>
				{/if}
				<p class="eyebrow">Cómo</p>
				<p>
					{f.pasos.lenguaje === 'powershell'
						? 'Con un script de PowerShell 5.1 o posterior, o paso a paso.'
						: f.pasos.lenguaje === 'sh'
							? 'Con un script de sh, o paso a paso.'
							: 'Paso a paso, en su panel.'}
					También tendrás un documento para el control de cambios.
				</p>
				{#if m.procedencia}
					<p class="eyebrow">Procedencia</p>
					<p>
						<a href={m.procedencia.url} rel="noreferrer noopener" target="_blank"
							>{m.procedencia.proyecto}</a
						>
						· {m.procedencia.licencia} · revisado y firmado por SeguridadSI
					</p>
				{/if}
			</aside>
		{:else if f.manifiesto}
			{@const x = f.manifiesto}
			<aside class="panel ficha">
				<h2>Qué se va a ejecutar</h2>
				{#if x.contenedor}
					<p class="eyebrow">Imagen</p>
					<p class="mono imagen">{x.contenedor.imagen}</p>
					<p class="eyebrow">Puertos</p>
					<p class="mono">
						{x.contenedor.puertos
							.map(
								(p) =>
									`${typeof p.expuesto === 'number' ? p.expuesto : 'el que elijas'} → ${p.interno}/${p.protocolo}`
							)
							.join(', ')}
					</p>
				{/if}
				{#if x.aislamiento}
					<p class="eyebrow">Aislamiento</p>
					<ul class="aisl">
						<li class:bien={!x.aislamiento.salida}>
							{x.aislamiento.salida ? 'Puede salir a internet' : 'Sin salida a internet'}
						</li>
						<li class:bien={x.aislamiento.soloLectura}>
							{x.aislamiento.soloLectura
								? 'Sistema de ficheros de solo lectura'
								: 'Sistema de ficheros escribible'}
						</li>
						<li class="bien">Sin capacidades de Linux, sin escalar privilegios</li>
						<li class="mono">{x.aislamiento.cpu} CPU · {x.aislamiento.memoriaMb} MB</li>
					</ul>
				{/if}
				{#if m.procedencia}
					<p class="eyebrow">Procedencia</p>
					<p>
						<a href={m.procedencia.url} rel="noreferrer noopener" target="_blank"
							>{m.procedencia.proyecto}</a
						>
						· {m.procedencia.licencia} · revisado y firmado por SeguridadSI
					</p>
				{/if}
			</aside>
		{/if}
	</div>
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

	.donde {
		margin: -8px 0 16px;
		font-size: 14px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.donde b {
		color: var(--ink);
	}

	.rejilla {
		display: grid;
		gap: 16px;
		grid-template-columns: minmax(0, 1fr) 360px;
		align-items: start;
	}

	.rejilla.sola {
		grid-template-columns: minmax(0, 1fr);
		max-width: 760px;
	}

	@media (max-width: 900px) {
		.rejilla {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.principal {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}

	.bloque,
	.formulario,
	.ficha {
		padding: 18px 20px 22px;
		min-width: 0;
	}

	h2 {
		font-size: 15px;
		font-weight: 600;
		margin: 18px 0 2px;
	}

	.bloque h2,
	.ficha h2,
	.formulario h2:first-of-type {
		margin-top: 0;
	}

	.ayuda {
		margin: 4px 0 10px;
		font-size: 13px;
		color: var(--ink-3);
	}

	.nota {
		margin: 8px 0 10px;
		padding: 10px 14px;
		border-radius: var(--r-sm);
		background: color-mix(in oklab, var(--warn) 10%, var(--surface));
		font-size: 13px;
		color: var(--ink-2);
	}

	.mas {
		margin: 12px 0 0;
		font-size: 13px;
		color: var(--ink-3);
	}

	.destinos,
	.vias {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.destinos > li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
		gap: 6px 16px;
		align-items: start;
		padding: 12px 0 12px 12px;
		border-bottom: 1px solid var(--line);
		box-shadow: inset 3px 0 0 var(--line-strong);
		font-size: 13.5px;
	}

	.destinos > li.vale {
		box-shadow: inset 3px 0 0 var(--ok);
	}

	.destinos > li:last-child {
		border-bottom: none;
	}

	.destinos p,
	.vias p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.quien {
		min-width: 0;
	}

	.nombre {
		font-weight: 600;
		font-size: 14.5px;
		color: var(--ink);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.nombre:hover {
		color: var(--accent);
	}

	.quien small {
		display: block;
		font-size: 12px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.resultado {
		min-width: 0;
	}

	.destinos .boton {
		white-space: nowrap;
	}

	@media (max-width: 760px) {
		.destinos > li {
			grid-template-columns: minmax(0, 1fr);
		}

		.destinos .boton {
			justify-self: start;
		}
	}

	.si,
	.no,
	.espera {
		font-size: 12.5px;
		font-weight: 600;
	}

	.si {
		color: var(--ok);
	}

	.no {
		color: var(--ink-3);
	}

	.espera {
		color: var(--warn);
	}

	.motivo {
		margin-top: 3px !important;
		color: var(--ink-2);
	}

	.remedio {
		margin-top: 3px !important;
		color: var(--ink);
	}

	.aviso-via {
		margin-top: 3px !important;
		font-size: 12.5px;
		color: var(--warn);
	}

	.via {
		margin: 4px 0 0;
		font-weight: 600;
	}

	.vias li {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		color: var(--ink-2);
		font-size: 13px;
	}

	.vias li p + p {
		margin-top: 3px;
	}

	.vias b {
		color: var(--ink);
		margin-right: 6px;
	}

	.vias small {
		font-size: 11px;
		color: var(--ink-3);
		margin-left: 4px;
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

	.remedio-error {
		display: block;
		color: var(--ink);
	}

	.enviar {
		margin-top: 22px;
	}

	.formulario .ayuda {
		margin: 18px 0 0;
	}

	.pasos {
		margin: 0;
		padding-left: 20px;
		font-size: 13px;
		color: var(--ink-2);
	}

	.pasos li + li {
		margin-top: 6px;
	}

	.ficha .eyebrow {
		margin: 16px 0 4px;
	}

	.ficha p {
		margin: 0;
		font-size: 13px;
	}

	.imagen {
		font-size: 11.5px;
		word-break: break-all;
		color: var(--ink-2);
	}

	.aisl {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 13px;
	}

	.aisl li {
		padding: 3px 0 3px 20px;
		position: relative;
		color: var(--warn);
	}

	.aisl li::before {
		content: '!';
		position: absolute;
		left: 4px;
		font-weight: 700;
	}

	.aisl li.bien {
		color: var(--ink);
	}

	.aisl li.bien::before {
		content: '✓';
		left: 2px;
		color: var(--ok);
	}

	.aisl li.mono {
		color: var(--ink-2);
	}

	.aisl li.mono::before {
		content: '';
	}
</style>
