<!--
	El mapa del despliegue: la consola arriba, una columna por red y, en cada una,
	sus sensores con su IP y sus trampas; debajo de cada sensor, los sistemas sin
	sensor cuya señal recibe. Las líneas se calculan midiendo las tarjetas ya
	puestas (lib/mapa-despliegue-lineas.ts), así que valen para cualquier ancho y cantidad.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { haceCuanto } from '$lib/formato';
	import {
		ORDEN_ESTADOS,
		detalleNodo,
		estadoEnPlural,
		filtrarMapa,
		rutaCorta,
		tituloZona,
		type SensorMapa,
		type SistemaMapa,
		type ZonaMapa
	} from '$lib/mapa-despliegue';
	import {
		CENTRO_SITIO,
		armarGrafo,
		grafoDeSensor,
		grafoDeSistema
	} from '$lib/mapa-despliegue-grafo';
	import {
		trazarFilas,
		trazarLineas,
		type Caja,
		type HijoEntrada,
		type RamaEntrada,
		type RamaFila,
		type Trazado
	} from '$lib/mapa-despliegue-lineas';
	import { puede } from '$lib/permisos';
	import DetalleMapa from './DetalleMapa.svelte';
	import GlifoEstado from './GlifoEstado.svelte';
	import GrafoEquipo from './GrafoEquipo.svelte';
	import IconoEquipo from './IconoEquipo.svelte';
	import TablaTrampas from './TablaTrampas.svelte';

	let { data, form } = $props();

	const ACTUALIZAR_CADA = 30_000;
	const CLAVE_PLEGADAS = 'sd.mapa.plegadas';
	const CLAVE_VISTA = 'sd.mapa.vista';
	/* Por debajo de este ancho el grafo no se lee bien: se empieza por la lista. */
	const ANCHO_GRAFO = 900;

	let texto = $state('');
	let soloProblemas = $state(false);
	let editando = $state<string | null>(null);
	let plegadas = $state<string[]>([]);
	let vista = $state<'grafo' | 'lista'>('grafo');
	let elegido = $state<string | null>(null);
	let lienzo = $state<HTMLElement>();
	let medidas = $state({ ancho: 0, alto: 0 });
	let trazado = $state<Trazado>({ trazos: [], flechas: [], pildoras: [] });

	const admin = $derived(puede(data.usuario?.roles ?? [], 'ajustes'));
	/* Quien puede editar un destino, como su ficha. */
	const opera = $derived(puede(data.usuario?.roles ?? [], 'desplegar'));
	const filtrando = $derived(texto.trim() !== '' || soloProblemas);
	const visible = $derived(filtrarMapa(data.mapa, texto, soloProblemas));
	const resumen = $derived(data.mapa.resumen);
	const consola = $derived(data.mapa.consola);
	const detalle = $derived(elegido ? detalleNodo(data.mapa, elegido) : null);
	/* Como mucho cuatro columnas; con menos redes, centradas bajo la consola. */
	const columnas = $derived(Math.max(1, Math.min(4, visible.zonas.length)));
	const estados = $derived(ORDEN_ESTADOS.filter((e) => resumen.porEstado[e]));
	const hayRele = $derived(data.mapa.zonas.some((z) => z.tipo === 'fuera'));
	const haySenal = $derived(
		data.mapa.zonas.some((z) => z.sensores.some((x) => x.sistemas.length > 0))
	);
	const hayCaidos = $derived(data.mapa.zonas.some((z) => z.sensores.some((x) => !x.vivo)));

	const estaPlegada = (clave: string) => plegadas.includes(clave);
	const todasPlegadas = $derived(data.mapa.zonas.every((z) => estaPlegada(z.clave)));
	function guardarPlegadas(claves: string[]) {
		plegadas = claves;
		try {
			localStorage.setItem(CLAVE_PLEGADAS, JSON.stringify(plegadas));
		} catch {
			/* Sin almacenamiento: se recuerda solo mientras dura la página. */
		}
	}
	const plegar = (clave: string) =>
		guardarPlegadas(
			estaPlegada(clave) ? plegadas.filter((c) => c !== clave) : [...plegadas, clave]
		);

	const metaDe = (x: SensorMapa) =>
		[x.plataforma, x.motor, x.version ? `version ${x.version}` : null].filter(Boolean).join(' · ');

	const latido = (x: SensorMapa) => {
		if (x.vivo)
			return `Online · ${x.ultimoLatido ? haceCuanto(x.ultimoLatido, data.ahora) : 'just now'}`;
		return x.ultimoLatido
			? `Offline · ${haceCuanto(x.ultimoLatido, data.ahora)}`
			: 'Never connected';
	};

	const pildoraDe = (x: SensorMapa) =>
		x.local ? 'Same machine as the console' : `${consola.puerto}/tcp · outbound from the sensor`;

	const contar = (z: ZonaMapa) => {
		const sistemas = z.sistemas.length + z.sensores.reduce((n, x) => n + x.sistemas.length, 0);
		const trampas = [...z.sistemas, ...z.sensores, ...z.sensores.flatMap((x) => x.sistemas)].reduce(
			(n, x) => n + x.trampas.length,
			0
		);
		return [
			z.sensores.length
				? `${z.sensores.length} ${z.sensores.length === 1 ? 'sensor' : 'sensors'}`
				: null,
			sistemas ? `${sistemas} ${sistemas === 1 ? 'system' : 'systems'}` : null,
			`${trampas} ${trampas === 1 ? 'decoy' : 'decoys'}`
		]
			.filter(Boolean)
			.join(' · ');
	};

	/* Cómo se ve la rama de una red plegada: mal, si tiene algún sensor caído. */
	const claseZona = (z: ZonaMapa) =>
		z.tipo === 'fuera' ? 'rele' : z.sensores.every((x) => x.vivo) ? 'ok' : 'mal';

	function medir() {
		if (!lienzo) return;
		const origen = lienzo.getBoundingClientRect();
		const caja = (e: Element): Caja => {
			const b = e.getBoundingClientRect();
			return {
				l: b.left - origen.left,
				t: b.top - origen.top,
				r: b.right - origen.left,
				b: b.bottom - origen.top
			};
		};
		const elConsola = lienzo.querySelector('[data-consola]');
		const redes = lienzo.querySelector('[data-redes]');
		if (!elConsola || !redes) return;
		/* Lo primero de cada columna baja directo. */
		const zonas = [...lienzo.querySelectorAll('[data-zona]')].map((e) => ({ e, c: caja(e) }));
		const tope = new Map<number, number>();
		for (const { c } of zonas) {
			const k = Math.round(c.l);
			tope.set(k, Math.min(tope.get(k) ?? Infinity, c.t));
		}
		const ramas: RamaEntrada[] = zonas.flatMap(({ e, c }) => {
			const primera = tope.get(Math.round(c.l)) === c.t;
			return [...e.querySelectorAll<HTMLElement>('[data-rama]')].map((m, i) => ({
				caja: caja(m),
				zona: c,
				clase: m.dataset.rama as RamaEntrada['clase'],
				directa: primera && i === 0,
				pildora: m.dataset.pildora ?? null
			}));
		});
		const hijos: HijoEntrada[] = [...lienzo.querySelectorAll<HTMLElement>('[data-hijo]')].flatMap(
			(h) => {
				const padre = h.closest('[data-grupo]')?.querySelector('[data-rama]');
				return padre
					? [{ padre: caja(padre), hijo: caja(h), clase: h.dataset.hijo as HijoEntrada['clase'] }]
					: [];
			}
		);
		const hueco = parseFloat(getComputedStyle(redes).columnGap) || 0;
		medidas = { ancho: lienzo.clientWidth, alto: lienzo.clientHeight };
		if (vista === 'lista') {
			trazado = trazarLineas({ consola: caja(elConsola), ramas, hijos, hueco });
			return;
		}
		/* En el grafo, cada sensor baja desde la barra de su fila. */
		const filas: RamaFila[] = zonas.flatMap(({ e, c }) => {
			const cuadros = [...e.querySelectorAll('[data-cuadro]')].map(caja);
			const arriba = Math.min(...cuadros.map((q) => q.t));
			return [...e.querySelectorAll<HTMLElement>('[data-rama]')].map((m) => {
				const cuadro = m.closest('[data-cuadro]');
				const q = caja(cuadro ?? m);
				return {
					caja: caja(m),
					cuadro: q,
					zona: c,
					clase: m.dataset.rama as RamaFila['clase'],
					pildora: m.dataset.pildora ?? null,
					primeraDeZona: !cuadro || Math.abs(q.t - arriba) < 2
				};
			});
		});
		const r = trazarFilas({ consola: caja(elConsola), ramas: filas });
		/* Y cada sitio, desde la barra que tiene encima hasta la caja de su sensor. */
		for (const grupo of lienzo.querySelectorAll('[data-grupo-sitios]')) {
			const principal = grupo.querySelector('[data-sitio-principal]');
			const sitios = [...grupo.querySelectorAll<HTMLElement>('[data-sitio]')];
			const centro = (s: Element) => s.querySelector('[data-centro]') ?? s;
			if (!principal || !sitios.length) continue;
			const t = trazarFilas({
				consola: caja(principal),
				margen: 8,
				ramas: sitios.map((s) => ({
					caja: caja(centro(s)),
					cuadro: caja(s),
					zona: caja(s),
					clase: s.dataset.sitio as RamaFila['clase'],
					pildora: s.dataset.pildora ?? null,
					primeraDeZona: true
				}))
			});
			r.trazos.push(...t.trazos);
			r.flechas.push(...t.flechas);
			r.pildoras.push(...t.pildoras);
		}
		trazado = r;
	}

	function cambiarVista(v: 'grafo' | 'lista') {
		vista = v;
		elegido = null;
		try {
			localStorage.setItem(CLAVE_VISTA, v);
		} catch {
			/* Sin almacenamiento: se recuerda solo mientras dura la página. */
		}
	}

	const alternarElegido = (id: string) => (elegido = elegido === id ? null : id);

	/* Cada cambio en lo que se enseña mueve las tarjetas. */
	$effect(() => {
		void visible;
		void plegadas;
		void editando;
		void vista;
		tick().then(medir);
	});

	onMount(() => {
		try {
			const guardadas = JSON.parse(localStorage.getItem(CLAVE_PLEGADAS) ?? '[]');
			if (Array.isArray(guardadas)) plegadas = guardadas.filter((c) => typeof c === 'string');
		} catch {
			/* Sin almacenamiento o con otra cosa guardada: todo desplegado. */
		}
		let guardada: string | null = null;
		try {
			guardada = localStorage.getItem(CLAVE_VISTA);
		} catch {
			/* Sin almacenamiento: según el ancho. */
		}
		if (guardada === 'grafo' || guardada === 'lista') vista = guardada;
		else if (window.innerWidth < ANCHO_GRAFO) vista = 'lista';
		const observador = new ResizeObserver(medir);
		if (lienzo) observador.observe(lienzo);
		document.fonts?.ready.then(medir);
		/* El mapa es para tenerlo abierto: se pone al día solo, salvo escribiendo un nombre. */
		const reloj = setInterval(() => {
			if (document.visibilityState === 'visible' && editando === null) invalidate('app:mapa');
		}, ACTUALIZAR_CADA);
		return () => {
			observador.disconnect();
			clearInterval(reloj);
		};
	});

	const flecha = (x: number, y: number) =>
		`${x},${y - 6.5} ${x - 6.5},${y + 6.5} ${x + 6.5},${y + 6.5}`;
</script>

<svelte:head><title>Deployment map</title></svelte:head>
<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') elegido = null;
	}}
/>

{#snippet sitio(y: SistemaMapa, conLinea: boolean)}
	<div
		class="sitio"
		data-sitio={conLinea ? y.linea : undefined}
		data-pildora={conLinea ? rutaCorta(y) : undefined}
	>
		<GrafoEquipo
			grafo={grafoDeSistema(y)}
			{elegido}
			onelegir={alternarElegido}
			claseCentro="de-sitio"
		>
			{#snippet centro()}
				<span class="centro-l1 entre">
					<span class="chip tipo-sitio">{y.tipo}</span>
					<IconoEquipo icono={y.icono} />
				</span>
				<span class="nom">{y.nombre}</span>
				{#if y.direccion}
					<span class="centro-ip chica">{y.direccion}</span>
				{:else if y.faltaDireccion}
					<span class="centro-ip chica falta">IP not set</span>
				{:else}
					<span class="centro-meta sin-color"
						>{y.linea === 'rele' ? 'No private IP' : 'IP not set'}</span
					>
				{/if}
			{/snippet}
		</GrafoEquipo>
	</div>
{/snippet}

{#snippet tarjetaSistema(x: SistemaMapa, conLinea: boolean)}
	<div class="sistema">
		{#if x.ruta}
			<p class="ruta" class:rele={x.ruta.rele}>
				{x.ruta.texto}
				{#if x.ruta.destino}<b class="mono">{x.ruta.destino}</b>{/if}
			</p>
		{/if}
		<article class="equipo hijo" data-hijo={conLinea ? x.linea : undefined}>
			<div class="l1">
				<span class="chip sin">NO SENSOR</span>
				<a class="nom" href={resolve('/targets/[id]', { id: x.id })}>{x.nombre}</a>
				<span class="tipo">{x.tipo}</span>
				<IconoEquipo icono={x.icono} />
			</div>
			{#if x.direccion}
				<div class="ip">{x.direccion}</div>
			{:else if x.faltaDireccion}
				<div class="ip falta">
					<span>IP not set</span>
					{#if opera}
						<a class="boton" href={resolve('/targets/[id]', { id: x.id })}>Set IP</a>
					{/if}
				</div>
			{/if}
			{#if x.plataforma}<div class="meta"><span>{x.plataforma}</span></div>{/if}
			{#if x.trampas.length}
				<TablaTrampas trampas={x.trampas} todas={filtrando} conRuta={!x.ruta} />
			{:else}
				<p class="vacio">No decoys deployed yet.</p>
			{/if}
		</article>
	</div>
{/snippet}

<div class="mapa-pagina">
	<header class="cabecera">
		<div>
			<h1>Deployment map</h1>
			<p class="resumen">
				<span><b>{resumen.sensores}</b> {resumen.sensores === 1 ? 'sensor' : 'sensors'}</span>
				<span
					><b>{resumen.sistemas}</b>
					{resumen.sistemas === 1 ? 'site without a sensor' : 'sites without a sensor'}</span
				>
				<span><b>{resumen.trampas}</b> {resumen.trampas === 1 ? 'decoy' : 'decoys'}</span>
				{#each estados as e (e)}
					<span class="estado">
						<GlifoEstado estado={e} />
						<b>{resumen.porEstado[e]}</b>
						{estadoEnPlural(e, resumen.porEstado[e] ?? 0)}
					</span>
				{/each}
			</p>
		</div>
		<div class="herramientas">
			<div class="vistas" role="group" aria-label="Map view">
				<button aria-pressed={vista === 'grafo'} onclick={() => cambiarVista('grafo')}>Graph</button
				>
				<button aria-pressed={vista === 'lista'} onclick={() => cambiarVista('lista')}>List</button>
			</div>
			<input
				type="search"
				bind:value={texto}
				placeholder="Search IP, machine, decoy or port"
				aria-label="Search the map"
			/>
			<button
				class="boton"
				aria-pressed={soloProblemas}
				onclick={() => (soloProblemas = !soloProblemas)}
			>
				Only with problems
			</button>
			{#if data.mapa.zonas.length > 3}
				<button
					class="boton"
					disabled={filtrando}
					onclick={() => guardarPlegadas(todasPlegadas ? [] : data.mapa.zonas.map((z) => z.clave))}
				>
					{todasPlegadas ? 'Expand all' : 'Collapse all'}
				</button>
			{/if}
		</div>
	</header>

	{#if form?.mensaje}<p class="ok" role="status">{form.mensaje}</p>{/if}
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<!-- Pinchar fuera de los nodos cierra el detalle; con teclado, Escape. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="lienzo" bind:this={lienzo} onclick={() => (elegido = null)}>
		<svg
			class="lineas"
			width={medidas.ancho}
			height={medidas.alto}
			viewBox="0 0 {medidas.ancho} {medidas.alto}"
			aria-hidden="true"
		>
			{#each trazado.trazos as t, i (i)}
				<path class="linea {t.clase}" d={t.d} />
			{/each}
			{#each trazado.flechas as f, i (i)}
				<polygon class="flecha {f.clase}" points={flecha(f.x, f.y)} />
			{/each}
		</svg>
		{#each trazado.pildoras as p, i (i)}
			<div class="pildora {p.clase}" style:left="{p.x}px" style:top="{p.y}px">{p.texto}</div>
		{/each}

		<div class="fila-consola">
			<div class="consola" data-consola>
				<div>
					<div class="l1">
						<span class="chip de-consola">CONSOLE</span>
						<span class="nom">
							Sugardaddy console{consola.equipo ? ` on ${consola.equipo}` : ''}
						</span>
					</div>
					<div class="ip">{consola.ip ?? consola.host ?? 'IP not reported'}</div>
				</div>
				<div class="der">
					<div>Listens on <b class="mono">{consola.puerto}/tcp</b></div>
					{#if consola.host && consola.ip}<div>{consola.host}</div>{/if}
					<div>{resumen.sensoresVivos} of {resumen.sensores} sensors online</div>
				</div>
			</div>
		</div>

		<div class="redes" class:en-grafo={vista === 'grafo'} data-redes style:--columnas={columnas}>
			{#each visible.zonas as z (z.clave)}
				{@const plegada = estaPlegada(z.clave) && !filtrando}
				<section class="zona" data-zona aria-label={tituloZona(z)}>
					<header class="cab">
						<div class="titulo">
							<button
								class="plegar"
								aria-expanded={!plegada}
								aria-label="{plegada ? 'Expand' : 'Collapse'} {tituloZona(z)}"
								onclick={() => plegar(z.clave)}>{plegada ? '▸' : '▾'}</button
							>
							<h2 class:mono-titulo={z.tipo === 'red' && !z.nombre && !!z.red}>{tituloZona(z)}</h2>
						</div>
						<p class="red">
							{#if z.nombre && z.red}<span class="mono">{z.red}</span>{/if}
							{#if z.vlan}<span class="mono">VLAN {z.vlan}</span>{/if}
							{#if z.entorno}<span>{z.entorno}</span>{/if}
							{#if z.tipo === 'fuera'}<span>No private IP</span>{/if}
							{#if z.tipo === 'red' && !z.red}
								<a href={resolve('/sensors')}>Set the range in Sensors</a>
							{/if}
							{#if admin && z.tipo === 'red' && editando !== z.clave}
								<button class="enlace" onclick={() => (editando = z.clave)}>
									{z.nombre ? 'Rename' : 'Set name'}
								</button>
							{/if}
						</p>
						{#if editando === z.clave}
							<form
								class="nombrar"
								method="POST"
								action="?/nombrar"
								use:enhance={() =>
									async ({ update }) => {
										await update({ reset: false });
										editando = null;
									}}
							>
								{#each z.sensores as x (x.id)}
									<input type="hidden" name="sensor" value={x.id} />
								{/each}
								<input
									name="nombre"
									maxlength="60"
									value={z.nombre ?? ''}
									placeholder="Servers, DMZ, Bilbao office…"
									aria-label="Network name"
								/>
								<button class="boton principal">Save</button>
								<button class="boton" type="button" onclick={() => (editando = null)}>Cancel</button
								>
							</form>
						{/if}
					</header>

					{#if plegada}
						<div class="plegada" data-rama={z.tipo === 'sin-senal' ? undefined : claseZona(z)}>
							{contar(z)}
						</div>
					{:else if vista === 'grafo'}
						<div class="cuadros">
							{#if z.tipo === 'fuera'}
								<div class="grupo-sitios" data-grupo-sitios>
									<div class="sitio" data-sitio-principal>
										<GrafoEquipo
											grafo={armarGrafo({
												idCentro: `c:zona:${z.clave}`,
												trampas: [],
												centro: CENTRO_SITIO
											})}
											{elegido}
											onelegir={alternarElegido}
											rama="rele"
											pildora={z.rele
												? `${consola.puerto}/tcp · console heartbeat`
												: 'Over the internet'}
											claseCentro="puerta"
										>
											{#snippet centro()}
												<span class="centro-l1">
													<span class="chip de-rele">{z.rele ? 'RELAY' : 'INTERNET'}</span>
												</span>
												<span class="nom"
													>{z.rele ? 'Public relay and Central' : 'Internet exit'}</span
												>
												<span class="centro-meta">No private IP</span>
											{/snippet}
										</GrafoEquipo>
									</div>
									<div class="sitios">
										{#each z.sistemas as y (y.id)}
											{@render sitio(y, true)}
										{/each}
									</div>
								</div>
							{:else if z.tipo === 'sin-senal'}
								<div class="sitios sueltos-grafo">
									{#each z.sistemas as y (y.id)}
										{@render sitio(y, false)}
									{/each}
								</div>
							{/if}
							{#each z.sensores as x (x.id)}
								<div class="grupo-sitios" data-grupo-sitios>
									<div class="sitio" data-sitio-principal>
										<GrafoEquipo
											grafo={grafoDeSensor(x)}
											{elegido}
											onelegir={alternarElegido}
											rama={x.vivo ? 'ok' : 'mal'}
											pildora={pildoraDe(x)}
											claseCentro={x.vivo ? '' : 'caido'}
										>
											{#snippet centro()}
												<span class="centro-l1">
													<span class="chip sensor">SENSOR</span>
													<span class="nom">{x.nombre}</span>
													<span class="tipo">{x.local ? 'Local' : 'Remote'}</span>
												</span>
												<span class="centro-ip" class:falta={!x.ip}
													>{x.ip ?? 'IP not reported'}</span
												>
												<span class="centro-meta" class:mal={!x.vivo}>{latido(x)}</span>
											{/snippet}
										</GrafoEquipo>
									</div>
									{#if x.sistemas.length}
										<div class="sitios">
											{#each x.sistemas as y (y.id)}
												{@render sitio(y, true)}
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						{#if z.tipo === 'fuera'}
							<div class="grupo" data-grupo>
								<div
									class="puerta"
									class:rele={z.rele}
									data-rama="rele"
									data-pildora={z.rele
										? `${consola.puerto}/tcp · console heartbeat`
										: 'Over the internet'}
								>
									<div class="l1">
										<span class="chip de-rele">{z.rele ? 'RELAY' : 'INTERNET'}</span>
										<span class="nom">{z.rele ? 'Public relay and Central' : 'Internet'}</span>
									</div>
									<p>
										{z.rele
											? 'Collects what happens outside; the console receives it in its heartbeat.'
											: "What happens outside reaches the console's public address or is queried through the cloud connectors."}
									</p>
								</div>
								<div class="sistemas">
									{#each z.sistemas as x (x.id)}
										{@render tarjetaSistema(x, true)}
									{/each}
								</div>
							</div>
						{:else if z.tipo === 'sin-senal'}
							<p class="vacio">Deploy a decoy on these sites to connect them to the map.</p>
							<div class="sueltos">
								{#each z.sistemas as x (x.id)}
									{@render tarjetaSistema(x, false)}
								{/each}
							</div>
						{/if}

						{#each z.sensores as x (x.id)}
							<div class="grupo" data-grupo>
								<article
									class="equipo"
									class:caido={!x.vivo}
									data-rama={x.vivo ? 'ok' : 'mal'}
									data-pildora={pildoraDe(x)}
								>
									<div class="l1">
										<span class="chip sensor">SENSOR</span>
										{#if x.ficha}
											<a class="nom" href={resolve('/targets/[id]', { id: x.ficha })}>{x.nombre}</a>
										{:else}
											<a class="nom" href={resolve('/sensors')}>{x.nombre}</a>
										{/if}
										<span class="tipo">{x.local ? 'Local' : 'Remote'}</span>
										<IconoEquipo icono="servidor" />
									</div>
									{#if x.ip}
										<div class="ip">{x.ip}</div>
									{:else}
										<div class="ip falta"><span>IP not reported</span></div>
									{/if}
									{#if x.otrasIps.length}
										<div class="otras">
											Also on <span class="mono">{x.otrasIps.join(', ')}</span>
										</div>
									{/if}
									<div class="meta">
										<span>{metaDe(x)}{!z.entorno && x.entorno ? ` · ${x.entorno}` : ''}</span>
										<span class="vivo" class:mal={!x.vivo}>{latido(x)}</span>
									</div>
									{#each x.avisos as a (a)}<div class="aviso-sensor">{a}</div>{/each}
									{#if x.trampas.length}
										<TablaTrampas trampas={x.trampas} todas={filtrando} conRuta />
									{:else if !x.sistemas.length}
										<p class="vacio">No decoys deployed yet.</p>
									{/if}
								</article>
								{#if x.sistemas.length}
									<div class="sistemas">
										{#each x.sistemas as y (y.id)}
											{@render tarjetaSistema(y, true)}
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					{/if}
				</section>
			{:else}
				<p class="nada">Nothing matches your search.</p>
			{/each}
		</div>
	</div>

	<footer class="leyenda">
		<div>
			<b>Decoy</b>
			{#each estados as e (e)}
				<span><GlifoEstado estado={e} />{resumen.etiquetas[e]}</span>
			{/each}
			{#if vista === 'grafo'}
				<span><span class="muestra-cuenta">3</span> events in the last 24 hours</span>
			{:else}
				<span><b>24 h</b> events in the last 24 hours</span>
			{/if}
		</div>
		<div>
			<b>Lines</b>
			<span
				><svg class="muestra" width="34" height="10"
					><line class="linea ok" x1="1" y1="5" x2="33" y2="5" /></svg
				>Sensor connected to the console</span
			>
			{#if hayCaidos}
				<span
					><svg class="muestra" width="34" height="10"
						><line class="linea mal" x1="1" y1="5" x2="33" y2="5" /></svg
					>Sensor offline</span
				>
			{/if}
			{#if haySenal}
				<span
					><svg class="muestra" width="34" height="10"
						><line class="linea senal" x1="1" y1="5" x2="33" y2="5" /></svg
					>Signal from a site to its sensor</span
				>
			{/if}
			{#if hayRele}
				<span
					><svg class="muestra" width="34" height="10"
						><line class="linea rele" x1="1" y1="5" x2="33" y2="5" /></svg
					>Signal from outside your network</span
				>
			{/if}
		</div>
		{#if vista === 'grafo'}
			<p class="pista">Click any element to see its details and what it is connected to.</p>
		{/if}
	</footer>
</div>

{#if detalle}
	<DetalleMapa
		{detalle}
		ahora={data.ahora}
		onelegir={(id) => (elegido = id)}
		oncerrar={() => (elegido = null)}
	/>
{/if}

<style>
	/* El mapa aprovecha todo el ancho de la ventana. */
	:global(main.contenido:has(.mapa-pagina)) {
		max-width: none;
	}

	.mapa-pagina {
		--hueco: 48px;
	}

	.cabecera {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px 24px;
	}

	h1 {
		margin: 0;
	}

	.resumen {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 16px;
		margin: 8px 0 0;
		font-size: 14px;
		color: var(--ink-2);
	}

	.resumen b {
		font-weight: 600;
		color: var(--ink);
	}

	.resumen .estado {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.herramientas {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.herramientas input {
		width: min(330px, 100%);
	}

	.vistas {
		display: inline-flex;
		overflow: hidden;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
	}

	.vistas button {
		padding: 7px 14px;
		border: 0;
		background: var(--surface);
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		cursor: pointer;
	}

	.vistas button[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.boton[aria-pressed='true'] {
		border-color: var(--accent);
		color: var(--accent);
	}

	.lienzo {
		position: relative;
		margin-top: 10px;
		padding-inline: calc(var(--hueco) / 2 + 8px);
	}

	.lineas {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
	}

	.linea {
		fill: none;
		stroke-width: 2.2;
	}

	.linea.ok {
		stroke: var(--accent);
	}

	.linea.mal {
		stroke: var(--crit);
		stroke-dasharray: 7 5;
	}

	.linea.senal {
		stroke: var(--ink-2);
		stroke-dasharray: 5 4;
	}

	.linea.rele {
		stroke: var(--s-media);
		stroke-dasharray: 2 6;
		stroke-linecap: round;
	}

	.flecha.ok {
		fill: var(--accent);
	}

	.flecha.mal {
		fill: var(--crit);
	}

	.flecha.senal {
		fill: var(--ink-2);
	}

	.flecha.rele {
		fill: var(--s-media);
	}

	.pildora {
		position: absolute;
		z-index: 3;
		padding: 2px 10px;
		transform: translate(-50%, -50%);
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		background: var(--bg);
		font-size: 12.5px;
		font-weight: 500;
		white-space: nowrap;
	}

	.pildora.rele {
		border-color: var(--s-media);
	}

	/* La consola */
	.fila-consola {
		position: relative;
		z-index: 2;
		display: flex;
		justify-content: center;
	}

	.consola {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 24px;
		width: min(620px, 100%);
		padding: 14px 20px;
		border: 1.5px solid var(--accent);
		border-radius: var(--r);
		background: var(--accent-soft);
	}

	.consola .ip {
		font: 600 34px/1.1 var(--font-mono);
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.consola .der {
		font-size: 14px;
		text-align: right;
		color: var(--ink-2);
	}

	.consola .der b {
		font-weight: 600;
		font-size: 16px;
		color: var(--ink);
	}

	.l1 {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
	}

	.nom {
		font: 600 16px var(--font-display);
		color: var(--ink);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	a.nom:hover {
		text-decoration: underline;
	}

	.tipo {
		font-size: 13px;
		color: var(--ink-2);
	}

	.chip {
		padding: 2px 8px;
		border-radius: 5px;
		font: 700 11px/1.4 var(--font-display);
		letter-spacing: 0.05em;
		white-space: nowrap;
	}

	.chip.de-consola {
		background: var(--accent);
		color: var(--accent-ink);
	}

	.chip.sensor {
		background: var(--marca);
		color: var(--marca-ink);
	}

	.chip.sin {
		padding: 1px 7px;
		border: 1px solid var(--line-strong);
		color: var(--ink-2);
	}

	.chip.de-rele {
		background: var(--s-media);
		color: var(--bg);
	}

	/* Las redes: columnas que se reparten solas según el ancho y lo que ocupa cada red. */
	.redes {
		column-count: var(--columnas);
		column-width: 340px;
		column-gap: var(--hueco);
		max-width: calc(var(--columnas) * 440px + (var(--columnas) - 1) * var(--hueco));
		margin: 84px auto 0;
	}

	/* En el grafo cada red mide lo que necesita y van por filas, con su barra en el hueco. */
	.redes.en-grafo {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: flex-start;
		gap: 64px 28px;
		max-width: none;
		column-count: auto;
	}

	.en-grafo .zona {
		max-width: 100%;
		margin-bottom: 0;
	}

	.en-grafo .cab {
		position: relative;
		z-index: 2;
		width: fit-content;
		max-width: 100%;
		min-height: 0;
		padding-right: 8px;
		background: var(--sunk);
	}

	.cuadros {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: flex-start;
		gap: 16px;
		overflow-x: auto;
	}

	/* Un sensor con su sitio y, debajo, los sitios cuya señal recibe. */
	.grupo-sitios {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.sitio {
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: var(--bg);
	}

	.sitios {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: flex-start;
		gap: 64px 20px;
		margin-top: 64px;
	}

	.sueltos-grafo {
		margin-top: 0;
	}

	.centro-l1.entre {
		justify-content: space-between;
	}

	.centro-l1 :global(.icono) {
		width: 16px;
		height: 16px;
	}

	.chip.tipo-sitio {
		padding: 1px 7px;
		overflow: hidden;
		border: 1px solid var(--line-strong);
		font-size: 10px;
		text-overflow: ellipsis;
		text-transform: uppercase;
		color: var(--ink-2);
	}

	.centro-ip.chica {
		font-size: 19px;
	}

	.centro-ip.chica.falta {
		font-size: 14px;
	}

	.centro-meta.sin-color {
		color: var(--ink-2);
	}

	.centro-l1 {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}

	.centro-l1 .nom {
		overflow: hidden;
		font-size: 14.5px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.centro-ip {
		font: 600 25px/1.15 var(--font-mono);
		letter-spacing: -0.01em;
	}

	.centro-ip.falta {
		font: 600 16px/1.4 var(--font-body);
		letter-spacing: 0;
		color: var(--warn);
	}

	.centro-meta {
		font-size: 12px;
		color: var(--ok);
	}

	.centro-meta.mal {
		font-weight: 600;
		color: var(--crit);
	}

	.muestra-cuenta {
		min-width: 18px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--marca);
		font: 700 10.5px/18px var(--font-mono);
		text-align: center;
		color: var(--marca-ink);
	}

	.pista {
		flex-basis: 100%;
		margin: 0;
		color: var(--ink-3);
	}

	.zona {
		margin-bottom: 24px;
		padding: 12px 14px 14px;
		border: 1.5px dashed var(--line-strong);
		border-radius: var(--r);
		background: var(--sunk);
		break-inside: avoid;
	}

	.cab {
		min-height: 50px;
		margin-bottom: 10px;
		/* La rama de la red baja por su derecha, sin pisar el título. */
		padding-right: calc(16% + 18px);
	}

	.titulo {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-left: -4px;
	}

	.plegar {
		flex: none;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		background: none;
		font-size: 14px;
		color: var(--ink-2);
		cursor: pointer;
	}

	.plegar:hover {
		color: var(--ink);
	}

	h2 {
		margin: 0;
		font: 700 18px/1.2 var(--font-display);
		overflow-wrap: anywhere;
	}

	h2.mono-titulo {
		font: 600 17px/1.2 var(--font-mono);
	}

	.red {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 12px;
		margin: 3px 0 0;
		font-size: 13px;
		color: var(--ink-2);
	}

	.red .mono {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--ink);
	}

	.enlace {
		padding: 0;
		border: 0;
		background: none;
		font-size: 13px;
		color: var(--ink-2);
		text-decoration: underline;
		cursor: pointer;
	}

	.enlace:hover {
		color: var(--ink);
	}

	.nombrar {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}

	.nombrar input {
		flex: 1 1 150px;
		min-width: 0;
	}

	.plegada {
		position: relative;
		z-index: 2;
		padding: 8px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		font-size: 13px;
		color: var(--ink-2);
	}

	/* Equipos */
	.grupo + .grupo {
		margin-top: 16px;
	}

	.equipo {
		position: relative;
		z-index: 2;
		padding: 11px 13px 8px;
		border: 1px solid var(--line-strong);
		border-radius: 11px;
		background: var(--surface);
	}

	.equipo.caido {
		border-color: var(--crit);
	}

	.ip {
		margin-top: 5px;
		font: 600 30px/1.15 var(--font-mono);
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.hijo .ip {
		font-size: 24px;
	}

	.ip.falta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font: 600 17px/1.5 var(--font-body);
		letter-spacing: 0;
		color: var(--warn);
	}

	.otras {
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0 10px;
		margin-top: 2px;
		font-size: 13px;
		color: var(--ink-2);
	}

	.vivo {
		color: var(--ok);
		white-space: nowrap;
	}

	.vivo.mal {
		font-weight: 600;
		color: var(--crit);
	}

	.aviso-sensor {
		margin-top: 3px;
		font-size: 12.5px;
		color: var(--warn);
	}

	.vacio {
		margin: 8px 0 4px;
		font-size: 13px;
		color: var(--ink-3);
	}

	/* Sistemas sin sensor, colgando de su sensor */
	.sistemas {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 8px;
		padding-left: 26px;
	}

	.ruta {
		margin: 0;
		padding: 4px 0 4px 2px;
		font-size: 12.5px;
		color: var(--ink-2);
	}

	.ruta b {
		font-weight: 500;
		font-size: 12.5px;
		color: var(--ink);
	}

	.ruta.rele b {
		color: var(--s-media);
	}

	.sueltos {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.puerta {
		position: relative;
		z-index: 2;
		padding: 10px 13px;
		border: 1px solid var(--s-media);
		border-radius: 11px;
		background: var(--surface);
	}

	.puerta .nom {
		font-size: 15px;
	}

	.puerta p {
		margin: 4px 0 0;
		font-size: 13px;
		color: var(--ink-2);
	}

	.nada {
		margin: 0;
		padding: 30px 0;
		text-align: center;
		color: var(--ink-2);
	}

	/* Leyenda */
	.leyenda {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 44px;
		margin-top: 10px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
		font-size: 13px;
		color: var(--ink-2);
	}

	.leyenda div {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 16px;
	}

	.leyenda b {
		font-weight: 600;
		color: var(--ink);
	}

	.leyenda span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	@media (max-width: 968px) {
		.mapa-pagina {
			--hueco: 20px;
		}

		.redes {
			margin-top: 76px;
		}

		.consola .der {
			text-align: left;
		}

		.consola .ip {
			font-size: 26px;
		}

		.ip {
			font-size: 26px;
		}

		.sistemas {
			padding-left: 20px;
		}
	}
</style>
