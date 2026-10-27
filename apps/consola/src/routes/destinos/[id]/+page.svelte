<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import EstadoTrampa from '$lib/components/EstadoTrampa.svelte';
	import FormularioDestino from '$lib/components/FormularioDestino.svelte';
	import { nombreFuente, nombreTipoDestino } from '$lib/destinos';
	import { enFrase, haceCuanto } from '$lib/formato';
	import { puede } from '$lib/permisos';

	let { data, form } = $props();
	const d = $derived(data.destino);
	const roles = $derived(page.data.usuario?.roles ?? []);
	const opera = $derived(puede(roles, 'desplegar'));
	const admin = $derived(puede(roles, 'ajustes'));
	const valen = $derived(d.queCabe.filter((m) => m.elegida).length);
	/* Lo guardado, o lo que se acaba de escribir si no se pudo guardar. */
	const valores = $derived(
		form?.accion === 'editar' && form.valores
			? form.valores
			: { nombre: d.nombre, ...d.descripcion }
	);
</script>

<svelte:head>
	<title>{d.nombre} — Sugardaddy</title>
</svelte:head>

<a class="volver" href={resolve('/sensores')}>← Sensores</a>

<div class="cabecera">
	<p class="eyebrow">{nombreTipoDestino(d.tipo)} · <span class="mono">{d.id}</span></p>
	<h1>{d.nombre}</h1>
	<p class="linea">
		{d.plataforma ?? 'Sin datos de su sistema'}
		·
		{#if d.sensor}
			sensor <a href={resolve('/sensores')}>{d.sensor.nombre}</a>,
			<span class="estado" class:mal={!d.sensor.vivo}
				>{d.sensor.vivo
					? 'en línea'
					: d.sensor.ultimoLatido
						? `sin contacto ${haceCuanto(d.sensor.ultimoLatido, data.ahora)}`
						: 'nunca ha contactado'}</span
			>
		{:else}
			sin sensor
		{/if}
	</p>
	{#if d.descripcion.nota}<p class="nota-destino">{d.descripcion.nota}</p>{/if}
</div>

{#if data.creado}
	<p class="ok" role="status">Destino añadido. Abajo ves qué se puede poner en él.</p>
{/if}
{#if form?.linea}
	<section class="panel token" role="status">
		<h2>Línea de instalación de <span class="mono">{form.para}</span></h2>
		<p>
			Pégala en el Ubuntu de esta máquina (o en una máquina virtual Ubuntu dentro de ella, con red
			puente). Vale una vez y 24 horas, y solo se muestra ahora. Tiene que llegar a esta consola por
			el 443 y resolver su nombre.
		</p>
		<p class="mono valor">{form.linea}</p>
	</section>
{/if}

{#if d.avisos.length}
	<!-- Lo que cuenta el sensor de su máquina: los mismos avisos que en Sensores. -->
	<section class="panel avisos" aria-label="Avisos del sensor">
		<ul>
			{#each d.avisos as a (a.codigo)}
				<li class:grave={a.gravedad === 'error'}>
					<p>
						<b>{a.titulo}</b>
						<small class="mono" title="Código para soporte">{a.codigo}</small>
					</p>
					<p>{a.texto}</p>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<div class="rejilla">
	<div class="principal">
		<section class="panel bloque">
			<h2>Qué puedes poner aquí</h2>
			{#if d.queCabe.length}
				<p class="ayuda">
					{valen === 0
						? 'Ahora no vale ninguna de las trampas de tu suscripción.'
						: valen === 1
							? 'Vale 1 de las trampas de tu suscripción.'
							: `Valen ${valen} de las trampas de tu suscripción.`}
					Se mira con sus ajustes de serie: al ponerla puedes cambiarlos.
				</p>
				<ul class="modulos">
					{#each d.queCabe as m (m.modulo)}
						<li class:vale={!!m.elegida}>
							<p class="modulo">
								<a href={resolve('/trampas/catalogo/[modulo]', { modulo: m.modulo })}>{m.nombre}</a>
								{#if m.elegida}
									<span class="si">Vale: {enFrase(m.elegida.nombre)}</span>
									<!-- Una forma a mano no necesita el sensor del destino; en un sensor, que conteste. -->
									{#if opera && (m.elegida.ejecutor === 'manual@1' || d.sensor?.vivo)}
										<a
											class="poner"
											href={`${resolve('/trampas/nueva/[modulo]', { modulo: m.modulo })}?${new URLSearchParams({ destino: d.id })}`}
											>Ponerla aquí</a
										>
									{/if}
								{:else}
									<span class="no">No vale aquí</span>
								{/if}
							</p>
							{#if m.motivo}
								<p class="motivo">{m.motivo.texto}</p>
							{/if}
							{#each m.elegida?.avisos ?? [] as a (a.codigo + a.texto)}
								<p class="aviso-via">{a.texto}</p>
							{/each}
							{#if !m.elegida || m.vias.length > 1}
								<details>
									<summary>Por qué</summary>
									<ul class="vias">
										{#each m.vias as v (v.via)}
											<li>
												<p>
													<b>{v.nombre}</b>
													<span class={v.vale ? 'si' : 'no'}>{v.vale ? 'vale' : 'no vale'}</span>
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
											</li>
										{/each}
									</ul>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="ayuda">
					Tu suscripción aún no incluye ninguna trampa. Cuando SeguridadSI te las autorice, verás
					aquí cuáles valen en este destino.
				</p>
			{/if}
		</section>

		<section class="panel bloque">
			<h2>Trampas aquí</h2>
			{#if d.trampas.length}
				<ul class="trampas">
					{#each d.trampas as t (t.id)}
						<li>
							{#if opera}
								<a href={resolve('/trampas/[id]', { id: t.id })}>{t.nombre}</a>
							{:else}
								<b>{t.nombre}</b>
							{/if}
							<span class="mono">{t.modulo}</span>
							<span class="estado"><EstadoTrampa estado={t.estado} motivo /></span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="ayuda">Aún no hay ninguna trampa en este destino.</p>
			{/if}
		</section>

		<section class="panel bloque">
			<h2>Lo que se sabe de este destino</h2>
			<p class="ayuda">
				Lo cuenta su sensor, lo sabe la consola o lo has dicho tú en el formulario. Si dos dicen lo
				mismo, manda el sensor.
			</p>
			{#if d.hechos.length}
				<dl class="hechos">
					{#each d.hechos as h (h.clave)}
						<div>
							<dt>
								{h.nombre ?? h.clave}
								{#if h.nombre}<small class="mono">{h.clave}</small>{/if}
							</dt>
							<dd>
								<span class="valor-hecho">{h.texto}</span>
								<small>
									{[
										h.fuente && `lo dice ${nombreFuente[h.fuente]}`,
										h.cuando && haceCuanto(h.cuando, data.ahora)
									]
										.filter(Boolean)
										.join(', ')}
									{#if h.motivo}<span class="mono motivo-hecho">{h.motivo}</span>{/if}
								</small>
							</dd>
						</div>
					{/each}
				</dl>
			{:else}
				<p class="ayuda">Nada todavía: descríbelo en «Editar».</p>
			{/if}
		</section>
	</div>

	<aside class="lateral">
		{#if opera}
			<form class="panel bloque" method="POST" action="?/editar" use:enhance>
				<h2>Editar</h2>
				{#if d.formulario.bloqueados.length}
					<p class="ayuda">Lo que ya dice su sensor no se cambia aquí.</p>
				{/if}
				{#if form?.accion === 'editar' && form.errores}
					<ul class="errores" role="alert">
						{#each form.errores as e (e)}<li>{e}</li>{/each}
					</ul>
				{:else if form?.accion === 'editar' && form.mensaje}
					<p class="hecho" role="status">{form.mensaje}</p>
				{/if}
				{#key d}
					<FormularioDestino
						tipo={d.tipo}
						{valores}
						bloqueados={d.formulario.bloqueados}
						delSensor={d.formulario.delSensor}
						soSensor={d.formulario.so}
						direcciones={d.formulario.direcciones}
					/>
				{/key}
				<button class="boton principal enviar">Guardar cambios</button>
			</form>
		{/if}

		{#if admin && !d.sensor && d.activo}
			<!-- Sin enhance: la página vuelve arriba, donde sale la línea. -->
			<form class="panel bloque" method="POST" action="?/instalar">
				<h2>Instalar un sensor aquí</h2>
				<p class="ayuda">
					Da de alta un sensor para esta máquina y te damos la línea que lo instala. Su sensor pasa
					a contar lo que es la máquina; lo que has dicho aquí sigue valiendo para lo que él no
					cuente.
				</p>
				{#if form?.accion === 'instalar' && form.error}
					<p class="errores" role="alert">{form.error}</p>
				{/if}
				<label for="s-id">Identificador del sensor</label>
				<input
					id="s-id"
					name="id"
					class="mono"
					value={form?.accion === 'instalar' ? form.id : d.id}
				/>
				<label for="s-nombre">Nombre</label>
				<input
					id="s-nombre"
					name="nombre"
					required
					value={form?.accion === 'instalar' ? form.nombre : d.nombre}
				/>
				<button class="boton enviar">Dar de alta y generar la línea</button>
			</form>
		{/if}

		{#if opera}
			<form class="panel bloque" method="POST" action="?/baja" use:enhance>
				<h2>Dar de baja</h2>
				{#if form?.accion === 'baja' && form.error}
					<p class="errores" role="alert">{form.error}</p>
				{/if}
				{#if d.sensor}
					<p class="ayuda">
						Este destino es la máquina de un sensor: se da de baja retirando el sensor, en
						<a href={resolve('/sensores')}>Sensores</a>.
					</p>
				{:else if d.trampas.length}
					<p class="ayuda">Tiene trampas: retíralas antes.</p>
					<button class="boton peligro" disabled>Dar de baja</button>
				{:else}
					<p class="ayuda">Se borra de la lista. Lo puedes volver a añadir cuando quieras.</p>
					<button class="boton peligro">Dar de baja</button>
				{/if}
			</form>
		{/if}
	</aside>
</div>

<style>
	.volver {
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.cabecera {
		margin: 14px 0 20px;
		min-width: 0;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
		overflow-wrap: anywhere;
	}

	.linea,
	.nota-destino {
		margin: 6px 0 0;
		color: var(--ink-2);
		font-size: 14px;
		overflow-wrap: anywhere;
	}

	.nota-destino {
		max-width: 70ch;
		color: var(--ink-3);
	}

	.estado {
		font-weight: 600;
		color: var(--ok);
	}

	.estado.mal {
		color: var(--crit);
	}

	.ok {
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
		border: 1px solid color-mix(in oklab, var(--ok) 40%, var(--line));
	}

	.token {
		padding: 16px 18px 18px;
		margin: 0 0 16px;
		border-color: var(--accent);
	}

	.token h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.token p {
		font-size: 13px;
		color: var(--ink-2);
		margin: 6px 0;
	}

	.valor {
		padding: 10px 12px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		color: var(--ink) !important;
		word-break: break-all;
		user-select: all;
	}

	.avisos {
		padding: 4px 18px;
		margin: 0 0 16px;
		border-color: var(--warn);
	}

	.avisos:has(.grave) {
		border-color: var(--crit);
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
	}

	.avisos li:last-child {
		border-bottom: none;
	}

	.avisos li.grave {
		box-shadow: inset 3px 0 0 var(--crit);
	}

	.avisos p {
		margin: 0;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.avisos p:first-child {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		margin-bottom: 3px;
		color: var(--ink);
	}

	.avisos small {
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.rejilla {
		display: grid;
		gap: 16px;
		grid-template-columns: minmax(0, 1fr) 380px;
		align-items: start;
	}

	@media (max-width: 960px) {
		.rejilla {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.principal,
	.lateral {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}

	.bloque {
		padding: 18px 20px 20px;
		min-width: 0;
	}

	.bloque h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.ayuda {
		margin: 4px 0 10px;
		font-size: 13px;
		color: var(--ink-3);
	}

	.hecho {
		margin: 8px 0 4px;
		padding: 9px 14px;
		border-radius: var(--r-sm);
		background: color-mix(in oklab, var(--ok) 12%, var(--surface));
		font-size: 13px;
	}

	p.errores {
		padding-left: 14px;
	}

	.errores {
		margin: 8px 0 4px;
		padding: 10px 14px 10px 30px;
		border-radius: var(--r-sm);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
		color: var(--crit);
		font-size: 13px;
	}

	.enviar {
		margin-top: 16px;
	}

	.boton:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.modulos,
	.trampas,
	.vias {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.modulos > li {
		padding: 10px 0 10px 12px;
		border-bottom: 1px solid var(--line);
		box-shadow: inset 3px 0 0 var(--line-strong);
		font-size: 13.5px;
	}

	.modulos > li.vale {
		box-shadow: inset 3px 0 0 var(--ok);
	}

	.modulos > li:last-child {
		border-bottom: none;
	}

	.modulos p,
	.vias p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.modulo {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 10px;
	}

	.modulo a {
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
	}

	.modulo a:hover {
		color: var(--accent);
	}

	.si,
	.no {
		font-size: 12px;
		font-weight: 600;
	}

	.modulo a.poner {
		font-size: 12px;
		font-weight: 600;
		color: var(--accent);
	}

	.si {
		color: var(--ok);
	}

	.no {
		color: var(--ink-3);
	}

	.motivo {
		margin-top: 3px !important;
		color: var(--ink-2);
	}

	.aviso-via {
		margin-top: 3px !important;
		font-size: 12.5px;
		color: var(--warn);
	}

	details {
		margin-top: 5px;
		font-size: 12.5px;
	}

	summary {
		cursor: pointer;
		color: var(--accent);
		width: max-content;
	}

	.vias li {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: var(--r-sm);
		background: var(--sunk);
		color: var(--ink-2);
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

	.remedio {
		color: var(--ink);
	}

	.trampas li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 12px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	.trampas li:last-child {
		border-bottom: none;
	}

	.trampas .mono {
		font-size: 12px;
		color: var(--ink-3);
	}

	.trampas .estado {
		margin-left: auto;
		text-align: right;
		max-width: 100%;
	}

	.hechos {
		margin: 0;
	}

	.hechos div {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		gap: 2px 14px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
	}

	.hechos div:last-child {
		border-bottom: none;
	}

	.hechos dt {
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.hechos dt small {
		display: block;
		font-size: 11px;
		color: var(--ink-3);
	}

	.hechos dd {
		margin: 0;
		min-width: 0;
	}

	.valor-hecho {
		overflow-wrap: anywhere;
	}

	.hechos dd small {
		display: block;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.motivo-hecho::before {
		content: '· ';
	}

	@media (max-width: 520px) {
		.hechos div {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
