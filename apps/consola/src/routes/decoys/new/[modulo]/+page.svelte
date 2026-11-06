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
	const aqui = $derived(resolve('/decoys/new/[modulo]', { modulo: m.id }));
	/* El formulario de un destino, con otra forma si el cliente la elige. */
	const en = (destino: string, via?: string) =>
		`${aqui}?${new URLSearchParams({ destino, ...(via ? { via } : {}) })}`;
	const valen = $derived(data.donde?.filter((d) => d.elegida && !d.bloqueo).length ?? 0);
	const elegida = $derived(f?.eleccion.elegida ?? null);
	const otras = $derived(f && elegida ? f.eleccion.vias.filter((v) => v.via !== elegida.via) : []);
	const plataforma = (p: string | null) => p ?? 'no system data';
</script>

<svelte:head>
	<title>Deploy {m.nombre} — Sugardaddy</title>
</svelte:head>

{#if f}
	<a class="volver" href={aqui}>← Choose another target</a>
{:else}
	<a class="volver" href={resolve('/decoys')}>← Decoys</a>
{/if}

<div class="cabecera">
	<p class="eyebrow">Deploy · {nombreTipo[m.tipo]}</p>
	<h1>{m.nombre}</h1>
	<p class="desc">{m.descripcion}</p>
</div>

{#if data.donde}
	<section class="panel bloque">
		<h2>Where do you want to deploy it?</h2>
		{#if data.donde.length}
			<p class="ayuda">
				{valen === 0
					? 'It cannot be deployed on any of your targets right now.'
					: `It can be deployed on ${valen} of your ${data.donde.length} targets.`}
				This is checked with its default settings; you can change them when you deploy it.
			</p>
			<ul class="destinos">
				{#each data.donde as d (d.id)}
					<li class:vale={d.elegida && !d.bloqueo}>
						<div class="quien">
							<a class="nombre" href={en(d.id)}>{d.nombre}</a>
							<small>
								{nombreTipoDestino(d.tipo)} · {plataforma(d.plataforma)} ·
								{d.sensor ? `sensor ${d.sensor.nombre}` : 'no sensor'}
							</small>
						</div>
						<div class="resultado">
							{#if d.elegida && !d.bloqueo}
								<p class="si">Supported: {enFrase(d.elegida.nombre)}</p>
							{:else if d.elegida}
								<p class="espera">Not possible right now</p>
								<p class="motivo">{d.bloqueo}</p>
							{:else}
								<p class="no">Not supported here</p>
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
							>{!d.elegida || d.bloqueo ? 'See why' : 'Deploy here'}</a
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="ayuda">
				You have no targets yet. Each sensor brings its own: it appears as soon as you enroll one.
			</p>
		{/if}
		{#if opera}
			<p class="mas">
				Is your target not listed? <a href={resolve('/targets/new')}>Add a target</a>.
			</p>
		{/if}
	</section>
{:else if f}
	<p class="donde">
		On <b>{f.destino.nombre}</b> · {nombreTipoDestino(f.destino.tipo)} · {plataforma(
			f.destino.plataforma
		)} · {f.destino.sensor ? `sensor ${f.destino.sensor.nombre}` : 'no sensor'}
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

					<h2>Method</h2>
					<p class="via">{elegida.nombre}</p>
					{#each elegida.avisos as a (a.codigo + a.texto)}
						<p class="aviso-via">{a.texto}</p>
					{/each}

					<label for="id">Identifier</label>
					<input id="id" name="id" class="mono" value={form?.id ?? ''} placeholder="ssh-fs02" />
					<p class="ayuda">
						Write it however you like: it is saved in lowercase with hyphens ("DNS Decoy" →
						dns-decoy). If left empty, it is derived from the display name.
					</p>

					<label for="nombre">Display name</label>
					<input
						id="nombre"
						name="nombre"
						required
						value={form?.nombre ?? m.nombre}
						placeholder="srv-fs02"
					/>
					<p class="ayuda">
						It defaults to the decoy's name; change it if you will deploy more than one.
					</p>

					<h2>Module parameters</h2>
					<FormularioParametros
						esquema={m.parametros}
						valores={form?.valores ?? data.propuestas}
						objetivos={f.objetivos}
					/>

					{#if f.pasos}
						<p class="ayuda">
							When you save, the console prepares the steps with these details and those of {f
								.destino.nombre}. You carry them out: the console does not connect to your machines.
						</p>
						<button class="boton principal enviar">Prepare the steps for {f.destino.nombre}</button>
					{:else}
						<button class="boton principal enviar">Deploy to {f.destino.nombre}</button>
					{/if}
				</form>
			{:else if elegida}
				<section class="panel bloque">
					<h2>{elegida.nombre}</h2>
					<p class="nota">{f.bloqueo}</p>
				</section>
			{:else}
				<section class="panel bloque">
					<h2>Not supported on {f.destino.nombre}</h2>
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
										<small class="mono" title="Support code">{x.codigo}</small>
									</p>
									{#if x.remedio}<p class="remedio">{x.remedio}</p>{/if}
								{/each}
							</li>
						{/each}
					</ul>
					<p class="mas"><a href={aqui}>Choose another target</a></p>
				</section>
			{/if}

			{#if otras.length}
				<section class="panel bloque">
					<h2>
						{otras.some((v) => v.vale)
							? 'Other methods'
							: 'Other methods and why they are not supported here'}
					</h2>
					<ul class="vias">
						{#each otras as v (v.via)}
							<li>
								<p>
									<b>{v.nombre}</b>
									<span class={v.vale ? 'si' : 'no'}
										>{v.vale ? 'supported' : 'not supported here'}</span
									>
								</p>
								{#each v.motivos as x (x.codigo + x.texto)}
									<p>
										{x.texto}
										<small class="mono" title="Support code">{x.codigo}</small>
									</p>
									{#if x.remedio}<p class="remedio">{x.remedio}</p>{/if}
								{/each}
								{#each v.avisos as x (x.codigo + x.texto)}
									<p class="aviso-via">{x.texto}</p>
								{/each}
								{#if v.vale}<p><a href={en(f.destino.id, v.via)}>Deploy this way</a></p>{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>

		{#if f.pasos}
			<!-- Una forma a mano: lo que harás en el destino, antes de rellenar nada. -->
			<aside class="panel ficha">
				<h2>What you will do on {f.destino.nombre}</h2>
				<ol class="pasos">
					{#each f.pasos.pasos as paso, i (i)}<li>{paso}</li>{/each}
				</ol>
				{#if f.pasos.retirada.length}
					<p class="eyebrow">To remove it</p>
					<ol class="pasos">
						{#each f.pasos.retirada as paso, i (i)}<li>{paso}</li>{/each}
					</ol>
				{/if}
				<p class="eyebrow">How</p>
				<p>
					{f.pasos.lenguaje === 'powershell'
						? 'With a PowerShell 5.1 (or later) script, or step by step.'
						: f.pasos.lenguaje === 'sh'
							? 'With an sh script, or step by step.'
							: 'Step by step, in its panel.'}
					You also get a document for change management.
				</p>
				{#if m.procedencia}
					<p class="eyebrow">Origin</p>
					<p>
						<a href={m.procedencia.url} rel="noreferrer noopener" target="_blank"
							>{m.procedencia.proyecto}</a
						>
						· {m.procedencia.licencia} · reviewed and signed by SeguridadSI
					</p>
				{/if}
			</aside>
		{:else if f.manifiesto}
			{@const x = f.manifiesto}
			<aside class="panel ficha">
				<h2>What will run</h2>
				{#if x.contenedor}
					<p class="eyebrow">Image</p>
					<p class="mono imagen">{x.contenedor.imagen}</p>
					<p class="eyebrow">Ports</p>
					<p class="mono">
						{x.contenedor.puertos
							.map(
								(p) =>
									`${typeof p.expuesto === 'number' ? p.expuesto : 'your choice'} → ${p.interno}/${p.protocolo}`
							)
							.join(', ')}
					</p>
				{/if}
				{#if x.aislamiento}
					<p class="eyebrow">Isolation</p>
					<ul class="aisl">
						<li class:bien={!x.aislamiento.salida}>
							{x.aislamiento.salida ? 'Can reach the internet' : 'No internet access'}
						</li>
						<li class:bien={x.aislamiento.soloLectura}>
							{x.aislamiento.soloLectura ? 'Read-only file system' : 'Writable file system'}
						</li>
						<li class="bien">No Linux capabilities, no privilege escalation</li>
						<li class="mono">{x.aislamiento.cpu} CPU · {x.aislamiento.memoriaMb} MB</li>
					</ul>
				{/if}
				{#if m.procedencia}
					<p class="eyebrow">Origin</p>
					<p>
						<a href={m.procedencia.url} rel="noreferrer noopener" target="_blank"
							>{m.procedencia.proyecto}</a
						>
						· {m.procedencia.licencia} · reviewed and signed by SeguridadSI
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

	@media (max-width: 1148px) {
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

	@media (max-width: 1008px) {
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
