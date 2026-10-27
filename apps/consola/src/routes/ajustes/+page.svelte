<script lang="ts">
	import { enhance } from '$app/forms';
	import { haceCuanto } from '$lib/formato';

	let { data, form } = $props();
	const c = $derived(data.canal);

	/* Tamaños en unidades legibles (base 1000, como los discos). */
	const tam = (n: number) =>
		n >= 1e9
			? (n / 1e9).toFixed(1) + ' GB'
			: n >= 1e6
				? (n / 1e6).toFixed(0) + ' MB'
				: n >= 1e3
					? (n / 1e3).toFixed(0) + ' KB'
					: n + ' B';
	const miles = (n: number) => n.toLocaleString('es-ES');
</script>

<svelte:head>
	<title>Ajustes — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Ajustes</h1>
</div>

{#if form?.mensaje}<p class="mensaje" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

<form class="panel bloque" method="POST" action="?/palabras" use:enhance>
	<h2>Palabras que disparan una alerta</h2>
	<p class="ayuda">
		Si una contraseña o un usuario probado contiene una de estas palabras, el evento pasa a crítico
		y se marca como alerta. Solo la palabra tal cual (sin importar mayúsculas ni tildes), sin
		variantes: pon la que de verdad os identifica, por ejemplo el nombre de la empresa. Mínimo
		{data.minimoPalabra} letras. Una por línea.
	</p>
	<textarea name="palabras" rows="3" class="mono" spellcheck="false"
		>{form?.palabras ?? data.palabras.join('\n')}</textarea
	>
	<button class="boton">Guardar</button>
</form>

<form class="panel bloque" method="POST" action="?/conservacion" use:enhance>
	<h2>Cuánto se guardan los eventos</h2>
	<p class="ayuda">
		Los eventos y la cuarentena de más de este plazo se borran solos, cada hora, y no se pueden
		recuperar. De estos datos sois responsables vosotros: poned el plazo que diga vuestra política
		de privacidad. Entre {data.conservacion.minimo} y {data.conservacion.maximo} días; 365 es un año.
		Los logs de la consola se guardan un año, o este plazo si es más largo.
	</p>
	{#if data.ahora < Date.parse(data.conservacion.aPartirDe)}
		<p class="ayuda">
			Los borrados empiezan el
			<b>{new Date(data.conservacion.aPartirDe).toLocaleDateString('es-ES')}</b>: hasta entonces no
			se borra nada, para que tengáis tiempo de cambiar el plazo.
		</p>
	{/if}
	<div class="plazo">
		<input
			id="dias"
			name="dias"
			type="number"
			inputmode="numeric"
			min={data.conservacion.minimo}
			max={data.conservacion.maximo}
			value={form?.dias ?? data.conservacion.dias}
		/>
		<label for="dias">días</label>
	</div>
	<button class="boton">Guardar</button>
</form>

<section class="panel bloque">
	<h2>Espacio de los eventos</h2>
	<p class="ayuda">
		Lo que ocupan los eventos y a qué ritmo crecen. Con el plazo de arriba no crecen sin fin: lo más
		viejo se borra solo, así que el tamaño se estabiliza.
	</p>
	<dl class="espacio">
		<div>
			<dt>Eventos guardados</dt>
			<dd>{miles(data.espacio.eventos)}</dd>
		</div>
		<div>
			<dt>Ocupan</dt>
			<dd>
				{tam(data.espacio.eventosBytes)}
				<span class="sub">de {tam(data.espacio.baseBytes)} en total</span>
			</dd>
		</div>
		<div>
			<dt>En el último mes</dt>
			<dd>
				{miles(data.espacio.eventosMes)}
				<span class="sub">(~{miles(Math.round(data.estimacion.ritmoDia))}/día)</span>
			</dd>
		</div>
		{#if data.espacio.masViejo}
			<div>
				<dt>El más viejo</dt>
				<dd>{haceCuanto(data.espacio.masViejo, data.ahora)}</dd>
			</div>
		{/if}
	</dl>
	{#if data.estimacion.fiable && data.estimacion.bytesPorEvento > 0}
		<p class="ayuda">
			A este ritmo, con el plazo de <b>{data.conservacion.dias} días</b> la base se estabiliza en
			torno a <b>{tam(data.estimacion.bytesEnPlazo)}</b> (~{miles(data.estimacion.eventosEnPlazo)}
			eventos). No sigue creciendo.
		</p>
	{:else}
		<p class="ayuda">Aún hay pocos eventos para estimar el tamaño con el plazo.</p>
	{/if}
	<form
		method="POST"
		action="?/purgarEventos"
		use:enhance
		onsubmit={(e) => {
			if (
				!confirm(
					`¿Borrar ahora los eventos de más de ${data.conservacion.dias} días? No se pueden recuperar.`
				)
			)
				e.preventDefault();
		}}
	>
		<button class="boton">Purgar ahora</button>
	</form>
	<p class="ayuda">
		«Purgar ahora» aplica el plazo al momento, sin esperar al borrado automático de cada hora.
	</p>
</section>

{#if data.loginLocal}
	<section class="panel bloque">
		<h2>Usuarios locales</h2>
		<p class="ayuda">
			Este nodo admite entrar con usuario y contraseña del propio nodo. Desde aquí das de alta a
			quién entra, le asignas su rol, le restableces la contraseña o lo retiras.
		</p>
		<a class="boton" href="/usuarios">Gestionar usuarios</a>
	</section>
{/if}

<section class="panel bloque">
	<h2>Llaves de emergencia</h2>
	<p class="ayuda">
		Para entrar como administrador si falla Entra o no hay internet. Conviene tener al menos dos,
		guardadas por separado.
	</p>
	{#if data.llaves.length === 0}
		<p class="mal">Este nodo no tiene ninguna: si Entra falla, nadie podrá entrar.</p>
	{:else}
		<ul class="llaves">
			{#each data.llaves as l (l.id)}
				<li>
					<b>{l.nombre}</b>
					<small>
						registrada por {l.registradaPor} el {new Date(l.creada).toLocaleDateString('es-ES')}
						{#if l.ultimoUso}· usada {haceCuanto(l.ultimoUso, data.ahora)}{/if}
					</small>
					<form method="POST" action="?/retirarLlave" use:enhance>
						<input type="hidden" name="id" value={l.id} />
						<button class="boton peligro">Retirar</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
	<a class="boton" href="/emergencia/alta">Registrar una llave</a>
</section>

<section class="panel bloque">
	<h2>Acceso de soporte de SeguridadSI</h2>
	{#if data.soporte.estado === 'solicitado' && data.soporte.solicitud}
		<p class="peticion">
			<b>{data.soporte.solicitud.por}</b> pide entrar:
			<span>«{data.soporte.solicitud.motivo}»</span>
		</p>
		<form class="soporte-decision" method="POST" action="?/soporteAceptar" use:enhance>
			<div>
				<label for="rol">Con qué rol</label>
				<select id="rol" name="rol">
					<option value="lector">Lector: solo mira</option>
					<option value="operador">Operador: puede tocar trampas</option>
				</select>
			</div>
			<div>
				<label for="horas">Durante</label>
				<select id="horas" name="horas">
					<option value="2">2 horas</option>
					<option value="8">8 horas</option>
				</select>
			</div>
			<button class="boton principal">Abrir acceso</button>
		</form>
		<form method="POST" action="?/soporteRechazar" use:enhance>
			<button class="boton">Rechazar</button>
		</form>
	{:else if data.soporte.estado === 'abierto'}
		<p class="ayuda">
			Abierto como <b>{data.soporte.rol}</b> hasta las
			{new Date(data.soporte.hasta ?? '').toLocaleString('es-ES')}. Todo lo que hagan queda en los
			logs.
		</p>
		<form method="POST" action="?/soporteCerrar" use:enhance>
			<button class="boton peligro">Cerrar ya</button>
		</form>
	{:else}
		<p class="ayuda">
			Cerrado. SeguridadSI solo puede pedir acceso; abrirlo, cuánto tiempo y con qué rol lo decides
			tú.
		</p>
	{/if}
</section>

<section class="panel bloque">
	<h2>Panel central de SeguridadSI</h2>

	{#if !c}
		<p class="ayuda">
			Este nodo funciona solo. Si lo das de alta, enviará cada minuto un latido con su versión y sus
			cifras (nunca eventos, IPs ni secretos) y recibirá las actualizaciones firmadas por
			SeguridadSI. Pide a SeguridadSI un código de alta.
		</p>
		<form method="POST" action="?/alta" use:enhance>
			<label for="panel">Dirección del panel</label>
			<input
				id="panel"
				name="panel"
				class="mono"
				required
				placeholder="https://central.sugardaddy…"
				value={form?.panel ?? ''}
			/>
			<label for="codigo">Código de alta</label>
			<input id="codigo" name="codigo" class="mono" required autocomplete="off" />
			<button class="boton principal">Dar de alta</button>
		</form>
	{:else}
		<dl>
			<dt>Estado</dt>
			<dd>
				{#if c.cortado}
					<b class="mal">Cortado por este cliente</b>
				{:else if c.error}
					<b class="mal">Sin conexión</b> <span class="mono">{c.error}</span>
				{:else}
					<b class="bien">Conectado</b>
				{/if}
			</dd>
			<dt>Panel</dt>
			<dd class="mono">{c.panel}</dd>
			<dt>Nodo · cliente</dt>
			<dd class="mono">{c.nodo} · {c.cliente}</dd>
			<dt>Último contacto</dt>
			<dd>{c.ultimoContacto ? haceCuanto(c.ultimoContacto, data.ahora) : 'nunca'}</dd>
			<dt>Huella del panel</dt>
			<dd class="mono" title="Fijada en el alta. Un estado firmado con otra clave se rechaza.">
				{c.huellaPanel}
			</dd>
			<dt>Huella de este nodo</dt>
			<dd class="mono">{c.huellaNodo}</dd>
			{#if c.estado}
				<dt>Versión</dt>
				<dd>
					<span class="mono">{data.version}</span>
					{#if data.actualizacion.estado === 'pendiente'}
						→ <b class="mono aviso">{data.actualizacion.version}</b> firmada y verificada, esperando al
						actualizador
					{:else if data.actualizacion.estado === 'aplicando'}
						→ <b class="mono aviso">{data.actualizacion.version}</b> instalándose
					{:else if data.actualizacion.estado === 'fallida'}
						· <b class="mal">la {data.actualizacion.version} falló y se volvió atrás</b>
						{#if data.actualizacion.detalle}<span class="mono">{data.actualizacion.detalle}</span
							>{/if}
					{:else}
						al día
					{/if}
					{#if c.estado.despliegueEnPausa}· despliegue en pausa{/if}
				</dd>
				<dt>Configuración</dt>
				<dd>
					{#if !data.configuracion}
						la de la instalación (se pondrá al día con la próxima versión)
					{:else if data.configuracion.estado === 'aplicada'}
						la firmada de la <span class="mono">{data.configuracion.version}</span>, aplicada
					{:else if data.configuracion.estado === 'aplicando'}
						<b class="aviso">aplicándose la de la {data.configuracion.version}</b>
					{:else}
						<b class="mal"
							>la de la {data.configuracion.version} no quedó sana y se volvió a la anterior</b
						>
						{#if data.configuracion.detalle}<span class="mono">{data.configuracion.detalle}</span
							>{/if}
					{/if}
					{#if data.relevo}
						<br /><b class="aviso"
							>el sensor {data.relevo.sensor} está pasando {data.relevo.remoto
								? 'su máquina'
								: 'el nodo'} a la configuración firmada desde las {new Date(
								data.relevo.desde
							).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}; {data.relevo
								.remoto
								? 'ese sensor'
								: 'el nodo'} no recibe versiones nuevas hasta que acabe (30 minutos como mucho)</b
						>
					{/if}
				</dd>
				<dt>Anillo</dt>
				<dd>{c.estado.anillo}</dd>
			{/if}
		</dl>

		<div class="acciones">
			{#if c.cortado}
				<form method="POST" action="?/reanudar" use:enhance>
					<button class="boton principal">Reanudar el canal</button>
				</form>
			{:else}
				<form method="POST" action="?/latir" use:enhance>
					<button class="boton">Latir ahora</button>
				</form>
				<form method="POST" action="?/cortar" use:enhance>
					<button class="boton peligro">Cortar el canal con SeguridadSI</button>
				</form>
			{/if}
		</div>
		<p class="ayuda">
			Cortar no apaga nada: las trampas siguen detectando y las respuestas siguen funcionando aquí.
			Solo deja de llegar información al panel y de aceptarse lo que mande.
		</p>
	{/if}
</section>

<style>
	.cabecera {
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.mensaje,
	.error {
		padding: 11px 16px;
		border-radius: var(--r);
		margin: 0 0 16px;
	}

	.mensaje {
		background: var(--accent-soft);
	}

	.error {
		color: var(--crit);
		background: color-mix(in oklab, var(--crit) 12%, var(--surface));
	}

	.bloque {
		margin-bottom: 16px;
		padding: 18px 20px 20px;
		max-width: 760px;
	}

	.bloque h2 {
		font-size: 16px;
		font-weight: 600;
	}

	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 8px 0 4px;
	}

	.bloque form .boton {
		margin-top: 16px;
	}

	.espacio {
		margin: 4px 0 6px;
		/* Una fila por dato. Explícito porque los dl heredan 2 columnas del estilo global. */
		display: grid;
		grid-template-columns: 1fr;
		gap: 0;
	}

	.espacio div {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		font-size: 14px;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
	}

	.espacio dt {
		color: var(--ink-3);
		margin: 0;
		white-space: nowrap;
	}

	.espacio dd {
		margin: 0;
		font-weight: 600;
		text-align: right;
	}

	.espacio dd .sub {
		white-space: nowrap;
	}

	.sub {
		color: var(--ink-3);
		font-weight: 400;
		font-size: 12.5px;
	}

	.plazo {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 12px 0;
	}

	.plazo input {
		width: 8em;
	}

	.llaves {
		list-style: none;
		margin: 10px 0 14px;
		padding: 0;
	}

	.llaves li {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 12px;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}

	.llaves small {
		color: var(--ink-3);
	}

	.peticion {
		margin: 10px 0 4px;
		font-size: 14px;
	}

	.peticion span {
		color: var(--ink-2);
	}

	.soporte-decision {
		display: flex;
		gap: 12px;
		align-items: flex-end;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	dl {
		display: grid;
		grid-template-columns: 160px 1fr;
		gap: 8px 16px;
		margin: 14px 0 0;
		font-size: 13.5px;
	}

	dt {
		color: var(--ink-3);
	}

	dd {
		margin: 0;
		word-break: break-all;
	}

	.bien {
		color: var(--ok);
	}

	.mal {
		color: var(--crit);
	}

	.aviso {
		color: var(--warn);
	}

	.acciones {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 18px;
	}

	textarea {
		width: 100%;
		resize: vertical;
		margin-bottom: 10px;
	}
</style>
