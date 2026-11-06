<script lang="ts">
	import { nombreSeveridad } from '$lib/formato';
	import { resolve } from '$app/paths';
	import { puede } from '$lib/permisos';
	import BotonPlegar from '$lib/components/BotonPlegar.svelte';
	import EstadoTrampa from '$lib/components/EstadoTrampa.svelte';
	import ListaEventos from '$lib/components/ListaEventos.svelte';
	import MapaOrigenes from '$lib/components/MapaOrigenes.svelte';
	import { textoGeo } from '$lib/formato';
	import { dondeVisible, estaPuesta, haceCuanto, nombreTipo } from '$lib/formato';
	import { AVISO_IP_MOTOR } from '$lib/capacidades';

	let { data } = $props();

	/* Las que ahora no reciben nada se ven apagadas; una degradada sigue a la vista. */
	const APAGADAS = ['parada', 'por-colocar', 'sin-contacto', 'retirando'];

	/* Qué secciones tiene plegadas quien mira (BotonPlegar lo recuerda en su navegador). */
	let plegado = $state({
		eventos: false,
		activos: false,
		origenes: false,
		trampas: false,
		primeros: false
	});

	const roles = $derived(data.usuario?.roles ?? []);
	const puedeDesplegar = $derived(puede(roles, 'desplegar'));
	const enLinea = $derived(data.sensores.filter((x) => x.vivo).length);

	/* Cada tarjeta lleva a su lista. El color solo dice el estado: nunca decora. */
	const tarjetas = $derived([
		{
			titulo: 'Events',
			valor: data.cifras.eventos,
			nota: 'Last 24 hours',
			href: '/events',
			tono: '',
			ayuda: 'View all events'
		},
		{
			titulo: 'Critical',
			valor: data.cifras.criticos,
			nota: 'Last 24 hours',
			href: '/events?desde=critica',
			tono: data.cifras.criticos > 0 ? 'mal' : '',
			ayuda: 'View critical events'
		},
		{
			titulo: 'Sources',
			valor: data.cifras.origenes,
			nota: 'Last 24 hours',
			/* Community no tiene incidentes por atacante. */
			href: data.community ? '/events' : '/incidents',
			tono: '',
			ayuda: 'View activity by source'
		},
		{
			titulo: 'Active decoys',
			valor: `${data.cifras.activos}/${data.cifras.total}`,
			nota: 'Verified by a real event',
			href: '/decoys',
			tono:
				data.cifras.total === 0 ? '' : data.cifras.activos === data.cifras.total ? 'bien' : 'ojo',
			ayuda: 'View decoys'
		},
		{
			titulo: 'Sensors online',
			valor: `${enLinea}/${data.sensores.length}`,
			nota:
				enLinea === data.sensores.length
					? 'All reporting'
					: `${data.sensores.length - enLinea} offline`,
			href: '/sensors',
			tono: data.sensores.length === 0 ? '' : enLinea === data.sensores.length ? 'bien' : 'ojo',
			ayuda: 'View sensors'
		}
	]);

	/* Salen solos de lo que ya ha pasado. Avisos, de pago y solo para quien administra. */
	const pasos = $derived([
		{ texto: 'Connect a sensor', hecho: data.pasos.sensor, href: '/sensors' },
		{ texto: 'Deploy your first decoy', hecho: data.pasos.trampa, href: '/decoys#catalog' },
		{ texto: 'Test it with a real event', hecho: data.pasos.probada, href: '/decoys' },
		...(!data.community && puede(roles, 'ajustes')
			? [{ texto: 'Set up your alerts', hecho: data.pasos.avisos, href: '/alerts' }]
			: [])
	]);
	const pasosPendientes = $derived(pasos.filter((x) => !x.hecho).length);
</script>

<svelte:head>
	<title>Dashboard — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<p class="eyebrow">Last 24 hours</p>
		<h1>Dashboard</h1>
	</div>
</div>

<div class="tarjetas">
	{#each tarjetas as t (t.titulo)}
		<a class="tarjeta {t.tono}" href={t.href} title={t.ayuda}>
			<span class="tarjeta-titulo">{t.titulo}</span>
			<b class="mono">{t.valor}</b>
			<small>{t.nota}</small>
		</a>
	{/each}
</div>

{#if pasosPendientes > 0 && puedeDesplegar}
	<section class="panel primeros" aria-labelledby="t-primeros">
		<header class="titulo" class:solo={plegado.primeros}>
			<h2 id="t-primeros">
				Get started <small>{pasos.length - pasosPendientes} of {pasos.length} done</small>
			</h2>
			<BotonPlegar id="resumen-primeros" titulo="Get started" bind:plegado={plegado.primeros} />
		</header>
		{#if !plegado.primeros}
			<ol>
				{#each pasos as paso (paso.texto)}
					<li class:hecho={paso.hecho}>
						<span class="marca-paso" aria-hidden="true">{paso.hecho ? '✓' : ''}</span>
						{#if paso.hecho}
							<span>{paso.texto}<span class="oculto"> (done)</span></span>
						{:else}
							<a href={paso.href}>{paso.texto}</a>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	</section>
{/if}

<div class="rejilla">
	<section class="panel">
		<header class="titulo" class:solo={plegado.eventos}>
			<h2>Latest events</h2>
			<span class="acciones">
				<a href={resolve('/events')}>View all</a>
				<BotonPlegar id="resumen-eventos" titulo="Latest events" bind:plegado={plegado.eventos} />
			</span>
		</header>
		{#if !plegado.eventos}
			<ListaEventos
				eventos={data.ultimos}
				nombres={data.nombres}
				modulos={data.modulos}
				geos={data.geos}
				ahora={data.ahora}
			/>
		{/if}
	</section>

	<div class="lateral">
		<section class="panel">
			<header class="titulo" class:solo={plegado.activos}>
				<h2>Most active sources</h2>
				<BotonPlegar
					id="resumen-activos"
					titulo="Most active sources"
					bind:plegado={plegado.activos}
				/>
			</header>
			{#if !plegado.activos}
				<ul class="origenes">
					{#each data.origenes as o (o.ip)}
						<li>
							<span class="ip">
								<span class="mono"
									>{o.ip}{#if o.geo?.tor}<span class="tor" title="Tor exit node">Tor</span
										>{/if}{#if o.oculta}<span class="tor" title={AVISO_IP_MOTOR}>Engine IP</span
										>{/if}</span
								>
								{#if o.geo}<small>{textoGeo(o.geo)}</small>{/if}
								{#if o.oculta}<small>not an attacker's IP</small>{/if}
							</span>
							<span class="sev sev-{o.peor}">{nombreSeveridad(o.peor)}</span>
							<span class="n mono">{o.eventos}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</div>

<div class="seccion">
	<h2>Sources</h2>
	<BotonPlegar id="resumen-origenes" titulo="Sources" bind:plegado={plegado.origenes} />
</div>
{#if !plegado.origenes}
	<section class="panel">
		<MapaOrigenes
			paises={data.geo.paises}
			regiones={data.geo.regiones}
			organizaciones={data.geo.organizaciones}
			dias={data.geo.dias}
		/>
	</section>
{/if}

<div class="seccion">
	<h2>Decoys by sensor</h2>
	<a class="ver-mapa" href={resolve('/map')}>View the deployment map</a>
	<BotonPlegar id="resumen-trampas" titulo="Decoys by sensor" bind:plegado={plegado.trampas} />
</div>
{#if !plegado.trampas}
	<div class="mapa">
		{#each data.sensores as s (s.id)}
			<section class="panel sensor" class:caido={!s.vivo}>
				<header>
					<div>
						<h3>{s.nombre}</h3>
						{#if s.red}<p class="mono">{s.red}</p>{/if}
					</div>
					<span class="latido" class:mal={!s.vivo}>
						{s.vivo
							? 'online'
							: s.ultimoLatido
								? `offline since ${haceCuanto(s.ultimoLatido, data.ahora)}`
								: 'never connected'}
					</span>
				</header>
				{#if s.avisos.length}
					<!-- El detalle, con lo que hay que hacer, está en Sensores. -->
					<a class="avisos-sensor" href={resolve('/sensors')}>
						{#each s.avisos as a (a.codigo)}
							<span class:grave={a.gravedad === 'error'}>{a.titulo}</span>
						{/each}
					</a>
				{/if}
				<ul>
					{#each s.trampas as x (x.id)}
						<li class:parado={APAGADAS.includes(x.estado.estado)}>
							<span
								class="estado"
								data-peor={x.peor}
								title={x.peor ? `Hit: ${nombreSeveridad(x.peor)}` : 'No events'}
							></span>
							<span class="nombre">
								<b>{x.nombre}</b>
								<small>
									<EstadoTrampa estado={x.estado} />
									<!-- Una trampa a mano: la recibe este sensor, pero está en su destino. -->
									{#if x.aMano}{' · '}manually deployed on {x.destino ??
											'its target'}{:else if estaPuesta(x.estado.estado)}{' · '}<span class="mono"
											>{dondeVisible(x.donde)}</span
										>{/if}
								</small>
							</span>
							<span class="tag">{nombreTipo[x.tipo]}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
{/if}

<style>
	.cabecera {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.tarjetas {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}

	.tarjeta {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 14px 16px;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--surface);
		color: var(--ink);
		text-decoration: none;
	}

	.tarjeta:hover {
		background: var(--surface-2);
	}

	.tarjeta.mal {
		border-color: color-mix(in oklab, var(--crit) 55%, var(--line));
	}

	.tarjeta.ojo {
		border-color: color-mix(in oklab, var(--warn) 55%, var(--line));
	}

	.tarjeta.bien {
		border-color: color-mix(in oklab, var(--ok) 55%, var(--line));
	}

	.tarjeta-titulo {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
	}

	.tarjeta b {
		font-size: 26px;
		font-weight: 500;
		line-height: 1.15;
	}

	.tarjeta.mal b {
		color: var(--crit);
	}

	.tarjeta small {
		font-size: 12px;
		color: var(--ink-3);
	}

	.primeros {
		margin-bottom: 16px;
	}

	.primeros h2 small {
		margin-left: 8px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--ink-3);
	}

	.primeros ol {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: 10px 18px;
		margin: 0;
		padding: 12px 17px 15px;
		list-style: none;
	}

	.primeros li {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 14px;
	}

	.primeros li.hecho {
		color: var(--ink-3);
	}

	.marca-paso {
		display: grid;
		flex: none;
		place-items: center;
		width: 20px;
		height: 20px;
		border: 1px solid var(--line-strong);
		border-radius: 50%;
		font-size: 12px;
	}

	.hecho .marca-paso {
		border-color: var(--ok);
		background: color-mix(in oklab, var(--ok) 18%, var(--surface));
		color: var(--ok);
	}

	.oculto {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	.rejilla {
		display: grid;
		gap: 16px;
		grid-template-columns: minmax(0, 1fr) 300px;
		align-items: start;
	}

	@media (max-width: 1248px) {
		.rejilla {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.titulo {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 14px 17px 10px;
		border-bottom: 1px solid var(--line);
	}

	.titulo h2 {
		font-size: 15px;
		font-weight: 600;
	}

	.titulo a {
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
	}

	.origenes {
		list-style: none;
		margin: 0;
		padding: 6px 0;
	}

	.origenes li {
		display: grid;
		grid-template-columns: 1fr auto 28px;
		gap: 10px;
		align-items: center;
		padding: 7px 17px;
		font-size: 13.5px;
	}

	.origenes .n {
		text-align: right;
		color: var(--ink-2);
	}

	.seccion {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin: 30px 0 12px;
	}

	.seccion h2 {
		font-size: 18px;
		font-weight: 600;
	}

	.ver-mapa {
		margin-right: auto;
		font-size: 13px;
		color: var(--ink-2);
	}

	.titulo .acciones {
		display: inline-flex;
		align-items: center;
		gap: 12px;
	}

	/* Plegada, la cabecera es lo único del panel: sin raya debajo. */
	.titulo.solo {
		border-bottom: 0;
	}

	.mapa {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
	}

	.sensor header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 10px;
		padding: 14px 16px 10px;
		border-bottom: 1px solid var(--line);
	}

	.sensor h3 {
		font-size: 15px;
		font-weight: 600;
	}

	.sensor header p {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--ink-3);
	}

	.latido {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ok);
		white-space: nowrap;
	}

	.latido.mal {
		color: var(--crit);
	}

	.caido {
		border-style: dashed;
	}

	.sensor ul {
		list-style: none;
		margin: 0;
		padding: 6px 0;
	}

	.sensor li {
		display: grid;
		grid-template-columns: 10px 1fr auto;
		gap: 11px;
		align-items: center;
		padding: 8px 16px;
	}

	.sensor li.parado {
		opacity: 0.5;
	}

	.estado {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--line-strong);
	}

	.estado[data-peor='baja'] {
		background: var(--s-baja);
	}
	.estado[data-peor='media'] {
		background: var(--s-media);
	}
	.estado[data-peor='alta'] {
		background: var(--s-alta);
	}
	.estado[data-peor='critica'] {
		background: var(--s-critica);
		box-shadow: 0 0 0 4px color-mix(in oklab, var(--s-critica) 25%, transparent);
	}

	.nombre {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.nombre b {
		font-size: 13.5px;
		font-weight: 600;
	}

	.nombre small {
		font-size: 11.5px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ip {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.ip small {
		font-size: 11.5px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.avisos-sensor {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 9px 16px;
		border-bottom: 1px solid var(--line);
		background: color-mix(in oklab, var(--warn) 8%, var(--surface));
		font-size: 12.5px;
		font-weight: 600;
		color: var(--warn);
		text-decoration: none;
	}

	.avisos-sensor .grave {
		color: var(--crit);
	}

	.tor {
		margin-left: 6px;
		white-space: nowrap;
		padding: 0 5px;
		border-radius: 4px;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--warn);
		background: color-mix(in oklab, var(--warn) 16%, transparent);
	}
</style>
