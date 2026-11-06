<script lang="ts">
	import { notaVisible } from '$lib/formato';
	import { nombreSeveridad } from '$lib/formato';
	import type { Evento as EventoFirmado } from '@sugardaddy/contrato';
	/*
	 * El evento firmado, más lo que le añade la consola al recibirlo: la alerta,
	 * o que lo provocó «Probar» (no es un ataque).
	 */
	type Triaje = { estado: string; nota: string | null } | null | undefined;
	type Evento = EventoFirmado & {
		alerta?: string | null;
		prueba?: boolean;
		triaje?: Triaje;
		/* Con la vista agrupada: cuántos eventos iguales representa esta fila (>1). */
		repeticiones?: number;
	};
	import { enhance } from '$app/forms';
	import { haceCuanto, horaCorta, horaLarga, nombreAccion, textoGeo, type Geo } from '$lib/formato';
	import { AVISO_IP_MOTOR } from '$lib/capacidades';

	/* El nombre legible de cada estado de triaje. */
	const ETIQUETA_TRIAJE: Record<string, string> = {
		revisado: 'Reviewed',
		'falso-positivo': 'False positive',
		interesante: 'Interesting'
	};

	type Modulos = Record<
		string,
		{ etiquetas: Record<string, string>; accion: string; resumen: string[] | null }
	>;
	type Visita = {
		geo: Geo | null;
		visita: Evento[];
		campoSesion: string | null;
		campoAccion: string | null;
		etiquetas: Record<string, string>;
	};

	let {
		eventos,
		nombres,
		modulos = {},
		geos = {},
		ahora,
		/* Con triaje: muestra el control para marcar cada evento (solo en /events,
		 * la única pantalla con las acciones de triaje). La insignia se ve siempre. */
		conTriaje = false,
		estadosTriaje = []
	}: {
		eventos: Evento[];
		nombres: Record<string, string>;
		modulos?: Modulos;
		geos?: Record<string, Geo>;
		ahora: number;
		conTriaje?: boolean;
		estadosTriaje?: readonly string[];
	} = $props();

	/*
	 * Origen y detalle los escribe el atacante. Se pintan como texto, recortados,
	 * y nunca con {@html}: un usuario llamado <script> se ve, no se ejecuta.
	 */
	const texto = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

	/* Lo que pasó, con el nombre que le da el módulo ("Password rejected") o, si no, la acción. */
	function que(e: Evento, etiquetas: Record<string, string>, campo: string | null) {
		const nativo = campo ? e.detalle?.[campo] : undefined;
		return (typeof nativo === 'string' && etiquetas[nativo]) || nombreAccion[e.accion];
	}

	/* Los datos del evento, sin los campos que ya se ven en otro sitio. */
	function datos(e: Evento, etiquetas: Record<string, string>, fuera: (string | null)[]) {
		return Object.entries(e.detalle ?? {})
			.filter(([k]) => !fuera.includes(k))
			.map(([k, v]) => ({ k, nombre: etiquetas[k] ?? k, v: texto(v) }));
	}

	function resumen(e: Evento) {
		const m = modulos[e.trampa.modulo];
		return datos(e, m?.etiquetas ?? {}, [m?.accion ?? null])
			.filter((d) => !m?.resumen || m.resumen.includes(d.k))
			.map((d) => `${d.nombre}: ${d.v}`)
			.join(' · ');
	}

	/*
	 * De la visita: lo que vale lo mismo en toda ella (protocolo, cliente,
	 * duración…) arriba, una vez; lo que cambia (contraseñas, comandos), en
	 * cada paso.
	 */
	function ordenar(v: Visita) {
		const fuera = [v.campoAccion];
		const valores = new Map<string, Set<string>>();
		const usuarios = new Set<string>();
		for (const e of v.visita) {
			if (e.origen.usuario) usuarios.add(e.origen.usuario);
			for (const d of datos(e, v.etiquetas, fuera)) {
				if (!valores.has(d.k)) valores.set(d.k, new Set());
				valores.get(d.k)!.add(d.v);
			}
		}
		const fijos = [...valores].filter(([, s]) => s.size === 1).map(([k]) => k);
		const primero = v.visita[0];
		const ultimo = v.visita[v.visita.length - 1];
		return {
			hechos: [
				{
					nombre: 'Source',
					v: [primero.origen.ip, primero.origen.puerto].filter(Boolean).join(':') || '—'
				},
				...(v.geo ? [{ nombre: 'From', v: textoGeo(v.geo) }] : []),
				...(v.geo?.tor ? [{ nombre: 'Tor', v: 'exit node' }] : []),
				...(usuarios.size === 1 ? [{ nombre: 'User', v: [...usuarios][0] }] : []),
				...fijos.map((k) => ({ nombre: v.etiquetas[k] ?? k, v: [...valores.get(k)!][0] }))
			],
			pasos: v.visita.map((e) => ({
				e,
				que: que(e, v.etiquetas, v.campoAccion),
				datos: [
					...(usuarios.size > 1 && e.origen.usuario
						? [{ k: 'usuario', nombre: 'User', v: e.origen.usuario }]
						: []),
					...datos(e, v.etiquetas, [...fuera, ...fijos])
				]
			})),
			desde: primero.cuando,
			hasta: ultimo.cuando,
			/* Lo pone el sensor (desde la 0.13.1): la IP es la de su motor de contenedores. */
			ipDelMotor: v.visita.some((e) => e.origen.oculta)
		};
	}

	let abierto = $state<string | null>(null);
	let cargando = $state(false);
	let fallo = $state<string | null>(null);
	let visita = $state<ReturnType<typeof ordenar> | null>(null);

	async function alternar(id: string) {
		if (abierto === id) {
			abierto = null;
			return;
		}
		abierto = id;
		visita = null;
		fallo = null;
		cargando = true;
		try {
			const r = await fetch(`/events/${id}`);
			if (!r.ok) throw new Error(`${r.status}`);
			const v: Visita = await r.json();
			if (abierto === id) visita = ordenar(v);
		} catch {
			if (abierto === id) fallo = 'Could not load the visit.';
		} finally {
			cargando = false;
		}
	}
</script>

<ul>
	{#each eventos as e (e.id)}
		{@const m = modulos[e.trampa.modulo]}
		<li class:abierto={abierto === e.id} class:con-alerta={!!e.alerta}>
			<button
				type="button"
				class="fila"
				aria-expanded={abierto === e.id}
				onclick={() => alternar(e.id)}
			>
				<span class="cuando">
					<b class="mono">{horaCorta(e.cuando)}</b>
					<small>{haceCuanto(e.cuando, ahora)}</small>
				</span>
				<span class="sevs">
					<span class="sev sev-{e.severidad}">{nombreSeveridad(e.severidad)}</span>
					{#if e.alerta}<span class="alerta" title={e.alerta}>alert</span>{/if}
					{#if e.prueba}<span class="prueba" title="Triggered by Test: not an attack">test</span
						>{/if}
					{#if e.triaje && !(e.repeticiones && e.repeticiones > 1)}<span
							class="triaje triaje-{e.triaje.estado}"
							title={notaVisible(e.triaje.nota)}
							>{ETIQUETA_TRIAJE[e.triaje.estado] ?? e.triaje.estado}</span
						>{/if}
					{#if e.repeticiones && e.repeticiones > 1}<span
							class="repes mono"
							title="{e.repeticiones} identical events grouped (of those loaded)"
							>×{e.repeticiones}</span
						>{/if}
				</span>
				<span class="que">
					<b>{nombres[e.trampa.id] ?? e.trampa.id}</b>
					<small>{que(e, m?.etiquetas ?? {}, m?.accion ?? null)}</small>
				</span>
				<span class="quien">
					<span class="mono"
						>{e.origen.ip ?? '—'}{#if e.origen.ip && geos[e.origen.ip]?.tor}<span
								class="tor"
								title="Tor exit node">Tor</span
							>{/if}{#if e.origen.oculta}<span class="motor" title={AVISO_IP_MOTOR}>Engine IP</span
							>{/if}</span
					>
					{#if e.origen.ip && geos[e.origen.ip]}
						<small title={textoGeo(geos[e.origen.ip])}>{textoGeo(geos[e.origen.ip])}</small>
					{/if}
					{#if e.origen.usuario || e.origen.equipo}
						<small class="mono"
							>{[e.origen.usuario, e.origen.equipo].filter(Boolean).join(' · ')}</small
						>
					{/if}
					{#if !e.conexionEstablecida}
						<small
							class="falseable"
							title="No complete TCP session: the source may be spoofed. It is not added to blocklists."
							>no session</small
						>
					{/if}
				</span>
				<span class="detalle mono">{resumen(e)}</span>
			</button>

			{#if abierto === e.id}
				<div class="visita">
					<div class="perfiles">
						{#if e.origen.ip && !e.origen.oculta}
							<a class="perfil-ip mono" href="/events/ip/{encodeURIComponent(e.origen.ip)}"
								>View everything from {e.origen.ip} →</a
							>
						{/if}
						{#if e.origen.usuario}
							<a class="perfil-ip mono" href="/events/user?u={encodeURIComponent(e.origen.usuario)}"
								>View everything for user {e.origen.usuario} →</a
							>
						{/if}
					</div>
					{#if conTriaje}
						<form method="POST" action="?/triaje" class="triaje-control" use:enhance>
							<input type="hidden" name="evento" value={e.id} />
							<span class="eyebrow">Triage</span>
							<div class="chips">
								{#each estadosTriaje as est (est)}
									<button
										name="estado"
										value={est}
										class="chip triaje-{est}"
										class:activo={e.triaje?.estado === est}>{ETIQUETA_TRIAJE[est] ?? est}</button
									>
								{/each}
							</div>
							<input
								name="nota"
								class="nota mono"
								placeholder="Note (optional)"
								value={notaVisible(e.triaje?.nota)}
								maxlength="2000"
								onkeydown={(ev) => ev.key === 'Enter' && ev.preventDefault()}
							/>
							{#if e.triaje}
								<button type="submit" formaction="?/quitarTriaje" class="quitar">Remove</button>
							{/if}
						</form>
					{/if}
					{#if cargando}
						<p class="nota">Loading the visit…</p>
					{:else if fallo}
						<p class="nota error">{fallo}</p>
					{:else if visita}
						<p class="eyebrow">
							Full visit · {visita.pasos.length}
							{visita.pasos.length === 1 ? 'event' : 'events'} · {horaLarga(visita.desde)} – {horaLarga(
								visita.hasta
							)}
						</p>
						{#if visita.ipDelMotor}
							<p class="nota aviso-ip">{AVISO_IP_MOTOR}</p>
						{/if}
						<dl>
							{#each visita.hechos as h (h.nombre)}
								<div>
									<dt>{h.nombre}</dt>
									<dd class="mono">{h.v}</dd>
								</div>
							{/each}
						</dl>
						<ol>
							{#each visita.pasos as p (p.e.id)}
								<li class:este={p.e.id === e.id}>
									<span class="mono hora">{horaLarga(p.e.cuando)}</span>
									<span class="punto sev-{p.e.severidad}" title={nombreSeveridad(p.e.severidad)}
									></span>
									<span class="paso">
										<b>{p.que}</b>
										{#if p.e.alerta}<span class="alerta">{p.e.alerta}</span>{/if}
										{#if p.e.prueba}<span class="prueba">test</span>{/if}
										{#each p.datos as d (d.k)}
											<span class="dato"
												><small>{d.nombre}</small> <code class="mono">{d.v}</code></span
											>
										{/each}
										<!-- La línea tal como la escribió el honeypot (lo que el módulo no recoge sigue
										     aquí); si no la manda, el evento entero tal como llegó del sensor. Siempre
										     está: «Qué hacer ahora» manda a mirarlo. -->
										<details class="crudo">
											<summary>view original</summary>
											<pre class="mono">{p.e.crudo ?? JSON.stringify(p.e, null, 2)}</pre>
										</details>
									</span>
								</li>
							{/each}
						</ol>
					{/if}
				</div>
			{/if}
		</li>
	{/each}
</ul>

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	ul > li {
		border-bottom: 1px solid var(--line);
	}

	ul > li:last-child {
		border-bottom: none;
	}

	.fila {
		all: unset;
		box-sizing: border-box;
		width: 100%;
		cursor: pointer;
		display: grid;
		grid-template-columns: 74px 68px minmax(150px, 1.1fr) minmax(150px, 1fr) minmax(0, 1.6fr);
		gap: 14px;
		align-items: center;
		padding: 11px 17px;
		font-size: 13.5px;
	}

	.fila:hover,
	.abierto .fila {
		background: var(--surface-2);
	}

	.fila:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.cuando,
	.que,
	.quien {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	small {
		font-size: 11.5px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sevs {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.alerta {
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 700;
		color: #fff;
		background: var(--crit);
		width: max-content;
	}

	.con-alerta {
		box-shadow: inset 3px 0 0 var(--crit);
	}

	.prueba {
		padding: 0 6px;
		border-radius: 4px;
		border: 1px solid var(--line);
		font-size: 11px;
		font-weight: 600;
		color: var(--ink-2);
		background: var(--surface-2);
		width: max-content;
	}

	/* La insignia de triaje: hereda la forma de .prueba, con color por estado. */
	.triaje {
		padding: 0 6px;
		border-radius: 4px;
		border: 1px solid var(--line);
		font-size: 11px;
		font-weight: 600;
		width: max-content;
		color: var(--ink-2);
		background: var(--surface-2);
	}

	.triaje-revisado {
		color: var(--ok, #15803d);
		border-color: color-mix(in srgb, var(--ok, #15803d) 40%, var(--line));
	}

	.triaje-falso-positivo {
		color: var(--ink-2);
	}

	.triaje-interesante {
		color: var(--warn);
		border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
	}

	/* La cuenta de eventos agrupados en una fila (×N). */
	.repes {
		padding: 0 6px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 700;
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--line);
		width: max-content;
	}

	/* Los enlaces a los perfiles (IP, usuario), al abrir una visita. */
	.perfiles {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		margin: 10px 0 2px;
	}

	.perfil-ip {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
	}

	.perfil-ip:hover {
		text-decoration: underline;
	}

	/* El control de triaje, dentro de la visita abierta. */
	.triaje-control {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 12px 0 4px;
		padding-bottom: 12px;
		border-bottom: 1px dashed var(--line);
	}

	.triaje-control .chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.triaje-control .chip {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--surface);
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-2);
		cursor: pointer;
	}

	.triaje-control .chip:hover {
		border-color: var(--ink-2);
		color: var(--ink);
	}

	.triaje-control .chip.activo {
		background: var(--ink);
		color: var(--surface);
		border-color: var(--ink);
	}

	.triaje-control .nota {
		flex: 1 1 200px;
		min-width: 0;
		padding: 4px 9px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		font-size: 12.5px;
		background: var(--surface);
		color: var(--ink);
	}

	.triaje-control .quitar {
		border: none;
		background: none;
		color: var(--ink-2);
		font-size: 12px;
		text-decoration: underline;
		cursor: pointer;
	}

	.que b {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.falseable {
		color: var(--warn);
	}

	.detalle {
		font-size: 12px;
		color: var(--ink-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.visita {
		padding: 4px 17px 18px 105px;
		background: var(--surface-2);
		border-top: 1px dashed var(--line);
	}

	.visita .eyebrow {
		margin: 12px 0 10px;
	}

	.nota {
		margin: 12px 0 0;
		color: var(--ink-3);
		font-size: 13px;
	}

	.nota.error {
		color: var(--warn);
	}

	.nota.aviso-ip {
		margin: 0 0 12px;
		color: var(--warn);
	}

	dl {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 26px;
		margin: 0 0 14px;
	}

	dl div {
		min-width: 0;
		max-width: 100%;
	}

	dt {
		font-size: 11px;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	dd {
		margin: 2px 0 0;
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}

	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		border-left: 1px solid var(--line);
	}

	ol li {
		display: grid;
		grid-template-columns: 64px 8px minmax(0, 1fr);
		gap: 10px;
		align-items: baseline;
		padding: 5px 8px 5px 12px;
		font-size: 13px;
	}

	ol li.este {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		border-radius: 6px;
	}

	.hora {
		font-size: 12px;
		color: var(--ink-3);
	}

	.punto {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		align-self: center;
		background: var(--sev);
	}

	.paso {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		min-width: 0;
	}

	.paso b {
		font-weight: 600;
	}

	.dato {
		min-width: 0;
		max-width: 100%;
	}

	.dato small {
		white-space: normal;
	}

	code {
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}

	@media (max-width: 1108px) {
		.fila {
			grid-template-columns: 64px 1fr;
			row-gap: 6px;
		}

		.sevs {
			grid-column: 1;
			grid-row: 2;
		}

		.detalle {
			grid-column: 1 / -1;
		}

		.visita {
			padding-left: 17px;
		}
	}

	.tor {
		margin-left: 6px;
		padding: 0 5px;
		border-radius: 4px;
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.03em;
		color: var(--warn);
		background: color-mix(in oklab, var(--warn) 16%, transparent);
		vertical-align: 1px;
	}

	.motor {
		margin-left: 6px;
		padding: 0 5px;
		border-radius: 4px;
		font-family: var(--font-body);
		font-size: 10.5px;
		font-weight: 600;
		color: var(--warn);
		background: color-mix(in oklab, var(--warn) 16%, transparent);
		vertical-align: 1px;
		white-space: nowrap;
	}

	.crudo {
		flex-basis: 100%;
		font-size: 12px;
	}

	.crudo summary {
		cursor: pointer;
		color: var(--accent);
		width: max-content;
	}

	.crudo pre {
		margin: 6px 0 2px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--sunk, var(--surface));
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 220px;
		overflow-y: auto;
	}
</style>
