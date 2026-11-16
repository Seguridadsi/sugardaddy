<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { pestanaDe } from '$lib/pestanas';
	import { fechaHora } from '$lib/fechas-pantalla';
	import { haceCuanto } from '$lib/formato';
	import MenuAjustes from '$lib/components/MenuAjustes.svelte';
	import Pestanas from '$lib/components/Pestanas.svelte';

	let { data, form } = $props();

	/* Cómo van (datos), adónde (configuración) y la prueba de restauración, por separado. */
	const PESTANAS = [
		{ id: 'status', texto: 'Status' },
		{ id: 'destination', texto: 'Destination' },
		{ id: 'restore-test', texto: 'Restore test' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));

	const d = $derived(data.destino);
	const e = $derived(data.estado);
	/* Lo escrito vuelve si el formulario falla; si no, lo guardado. */
	const v = $derived((form as { valores?: Record<string, string> } | null)?.valores ?? null);
	const val = (campo: string, guardado: string | number | boolean | null | undefined) =>
		v ? (v[campo] ?? '') : guardado === null || guardado === undefined ? '' : String(guardado);

	let tipo = $state('');
	$effect(() => {
		tipo = v?.tipo ?? d?.tipo ?? 's3';
	});

	const tam = (n: number) =>
		n >= 1e9
			? (n / 1e9).toFixed(1) + ' GB'
			: n >= 1e6
				? (n / 1e6).toFixed(1) + ' MB'
				: n >= 1e3
					? Math.round(n / 1e3) + ' KB'
					: n + ' B';
	const NOMBRE_TIPO: Record<string, string> = {
		s3: 'S3-compatible bucket',
		azure: 'Azure Blob container',
		smb: 'Shared folder (SMB)'
	};
	const RESULTADO: Record<string, string> = {
		ok: 'Passed',
		'sin-clave': 'Passed, without decryption',
		fallo: 'Failed'
	};
</script>

<svelte:head>
	<title>Backups — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<h1>Settings</h1>
</div>

<MenuAjustes actual="backups" />

<p class="ayuda intro">
	Every night the node makes a backup — database, secrets and the console certificate authority —
	encrypted with age to your public key, in <code class="mono">{data.carpeta}/copias</code>. Here
	you choose where a copy of each one goes outside this machine, how many stay there and whether
	they are locked against deletion. Once a month the node downloads the latest one and checks it can
	be restored.
</p>

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Backup sections" />

{#if form?.mensaje}<p class="bien" role="status">{form.mensaje}</p>{/if}
{#if form?.error}<p class="mal" role="alert">{form.error}</p>{/if}

{#if pestana === 'status'}
	{#each data.problemas as p (p.titulo)}
		<section class="panel bloque problema" role="alert">
			<h2>{p.titulo}</h2>
			<p>{p.texto}</p>
		</section>
	{/each}
	<section class="panel bloque">
		<h2>On this machine</h2>
		{#if e.local}
			<p>
				Latest backup <code class="mono">{e.local.nombre}</code>, {tam(e.local.bytes)},
				{haceCuanto(e.local.cuando)}.
			</p>
		{:else if e.informe}
			<p class="mal">There is no backup on this machine yet.</p>
		{:else}
			<p class="ayuda">
				The node updater has not reported yet. It does so within a minute of starting; an updater
				older than this console does not report at all.
			</p>
		{/if}
	</section>
	<section class="panel bloque">
		<h2>In your storage</h2>
		{#if !d}
			<p class="aviso">
				Backups only stay on this machine: if its disk fails or someone wipes it, they are lost with
				it. <a href="?tab=destination">Choose a destination</a>.
			</p>
		{:else}
			<p>
				{NOMBRE_TIPO[d.tipo]} <code class="mono">{d.donde}</code>{#if !d.activo}
					— <b>paused</b>{/if}. Keeps the latest {d.conservar}{#if d.inmutable}, each locked for {d
						.inmutable.dias}
					{d.inmutable.dias === 1 ? 'day' : 'days'} ({d.inmutable.modo}){/if}.
			</p>
			{#if d.ilegible}<p class="mal">{d.ilegible}</p>{/if}
			{#if e.ultimaSubida}
				<p class="bien">
					Last upload <code class="mono">{e.ultimaSubida.nombre}</code>, {tam(
						e.ultimaSubida.bytes
					)},
					{haceCuanto(e.ultimaSubida.cuando)}.
				</p>
				<p class="ayuda">SHA-256 <code class="mono hash">{e.ultimaSubida.sha256}</code></p>
			{:else if d.activo}
				<p class="ayuda">Nothing uploaded to this destination yet.</p>
			{/if}
			{#if e.ultimoError}
				<p class="mal">
					Failing since {fechaHora(e.ultimoError.desde)}: {e.ultimoError.detalle}
				</p>
			{/if}
			{#if e.bloqueadas}
				<p class="ayuda">
					{e.bloqueadas} older backup(s) are still locked by the storage's immutability: they will be
					removed once the lock expires.
				</p>
			{/if}
			{#each e.avisos as a (a)}<p class="aviso">{a}</p>{/each}
			{#if e.conexion}
				<p class={e.conexion.ok ? 'bien' : 'mal'}>
					Destination check {fechaHora(e.conexion.cuando)}: {e.conexion.detalle}
				</p>
			{/if}
			{#if d.activo}
				<form method="POST" action="?/comprobar" use:enhance>
					<button class="boton" disabled={d.pedidos.comprobar}
						>{d.pedidos.comprobar ? 'Check requested…' : 'Check the destination now'}</button
					>
				</form>
			{/if}
		{/if}
	</section>
	{#if d && e.remotas.length}
		<section class="panel bloque">
			<h2>Backups in your storage</h2>
			<p class="ayuda">As listed by the node updater {haceCuanto(e.remotasCuando ?? '')}.</p>
			<table>
				<thead><tr><th>Backup</th><th>Size</th></tr></thead>
				<tbody>
					{#each e.remotas as r (r.nombre)}
						<tr><td><code class="mono">{r.nombre}</code></td><td>{tam(r.bytes)}</td></tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
{:else if pestana === 'destination'}
	<section class="panel bloque">
		<h2>Destination</h2>
		{#if !data.claveLista}
			<p class="mal">
				This node has no key for encrypting secrets (CLAVE_SECRETOS in its .env file): the
				credential cannot be saved until it has one.
			</p>
		{/if}
		{#if data.soporte}
			<p class="mal">Support sessions cannot change where the backups go.</p>
		{/if}
		<p class="ayuda">
			Give the node a credential that can only write, read, list and delete in that place, nothing
			else. It is stored encrypted with this node's key and only the node updater reads it. The
			backups are already encrypted to your public key: the storage never sees their content.
		</p>
		<form method="POST" action="?/guardar" use:enhance>
			<input type="hidden" name="version" value={d?.version ?? 0} />
			<fieldset class="tipos">
				<legend>Where</legend>
				{#each Object.entries(NOMBRE_TIPO) as [id, texto] (id)}
					<label><input type="radio" name="tipo" value={id} bind:group={tipo} /> {texto}</label>
				{/each}
			</fieldset>

			{#if tipo === 's3'}
				<p class="ayuda">
					Amazon S3, MinIO, Wasabi, Ceph, Cloudflare R2 or any S3-compatible service. The access key
					needs s3:PutObject, s3:GetObject, s3:ListBucket and s3:DeleteObject on the bucket.
				</p>
				<label class="campo">
					<span>Endpoint (empty for Amazon S3)</span>
					<input
						name="endpoint"
						value={val('endpoint', d?.s3?.endpoint)}
						placeholder="https://minio.company.local:9000"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				<div class="dos">
					<label class="campo">
						<span>Bucket</span>
						<input
							name="bucket"
							value={val('bucket', d?.s3?.bucket)}
							required
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
					<label class="campo">
						<span>Region</span>
						<input
							name="region"
							value={val('region', d?.s3?.region ?? 'us-east-1')}
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
				</div>
				<label class="campo">
					<span>Folder in the bucket (optional)</span>
					<input
						name="prefijo"
						value={val('prefijo', d?.s3?.prefijo)}
						placeholder="sugardaddy/madrid"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				<label class="campo">
					<span>Addressing</span>
					<select
						name="estiloRuta"
						value={val('estiloRuta', d?.s3 ? (d.s3.estiloRuta ? 'si' : 'no') : '')}
					>
						<option value=""
							>Automatic (path style with an endpoint, virtual host on Amazon S3)</option
						>
						<option value="si">Path style (https://server/bucket/…)</option>
						<option value="no">Virtual host (https://bucket.server/…)</option>
					</select>
				</label>
				<label class="campo">
					<span>Access key ID</span>
					<input
						name="claveId"
						value={val('claveId', d?.s3?.claveId)}
						required
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				<label class="campo">
					<span
						>Secret access key{#if d?.tipo === 's3'}
							(empty: keep the saved one{d.final ? `, ending in ${d.final}` : ''}){/if}</span
					>
					<input
						name="secreto"
						type="password"
						autocomplete="new-password"
						required={d?.tipo !== 's3'}
					/>
				</label>
			{:else if tipo === 'azure'}
				<p class="ayuda">
					Create a SAS for the container (not for the account) with the permissions Read, Add,
					Create, Write, Delete and List (<code>sp=racwdl</code>; add <code>i</code>, «Set
					immutability policy», to lock each backup) and an expiry date you will remember to renew.
				</p>
				<label class="campo">
					<span
						>Container SAS URL{#if d?.tipo === 'azure'}
							(empty: keep the saved one for <code>{d.azure?.contenedor}</code>){/if}</span
					>
					<input
						name="secreto"
						type="password"
						placeholder="https://account.blob.core.windows.net/backups?sv=…&sig=…"
						autocomplete="off"
						required={d?.tipo !== 'azure'}
					/>
				</label>
				<label class="campo">
					<span>Folder in the container (optional)</span>
					<input
						name="prefijo"
						value={val('prefijo', d?.azure?.prefijo)}
						placeholder="sugardaddy/madrid"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
			{:else}
				<p class="ayuda">
					A Windows share, a NAS or Samba. Docker on this machine mounts it for a few seconds for
					each upload (the Linux kernel SMB client); nothing is installed.
				</p>
				<div class="dos">
					<label class="campo">
						<span>Server (name or IP)</span>
						<input
							name="servidor"
							value={val('servidor', d?.smb?.servidor)}
							placeholder="nas.company.local"
							required
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
					<label class="campo">
						<span>Share</span>
						<input
							name="recurso"
							value={val('recurso', d?.smb?.recurso)}
							placeholder="Backups"
							required
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
				</div>
				<label class="campo">
					<span>Folder in the share (optional)</span>
					<input
						name="prefijo"
						value={val('prefijo', d?.smb?.carpeta)}
						placeholder="sugardaddy/madrid"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				<div class="dos">
					<label class="campo">
						<span>User</span>
						<input
							name="usuario"
							value={val('usuario', d?.smb?.usuario)}
							required
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
					<label class="campo">
						<span>Domain (optional)</span>
						<input
							name="dominio"
							value={val('dominio', d?.smb?.dominio)}
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
				</div>
				<label class="campo">
					<span
						>Password{#if d?.tipo === 'smb'}
							(empty: keep the saved one){/if}</span
					>
					<input
						name="secreto"
						type="password"
						autocomplete="new-password"
						required={d?.tipo !== 'smb'}
					/>
				</label>
				<label class="campo">
					<span>Encryption in transit</span>
					<select
						name="cifrado"
						value={val('cifrado', d?.smb ? (d.smb.cifrado ? 'si' : 'no') : 'si')}
					>
						<option value="si">Require SMB 3 encryption (recommended)</option>
						<option value="no">Do not require it (old servers)</option>
					</select>
				</label>
			{/if}

			<div class="dos">
				<label class="campo">
					<span>Backups to keep in your storage</span>
					<input
						name="conservar"
						type="number"
						min="1"
						max="365"
						value={val('conservar', d?.conservar ?? data.conservarDefecto)}
					/>
				</label>
				{#if tipo !== 'smb'}
					<label class="campo">
						<span>Lock each backup for (days, 0 = off)</span>
						<input
							name="inmutableDias"
							type="number"
							min="0"
							max="3650"
							value={val('inmutableDias', d?.inmutable?.dias ?? 0)}
						/>
					</label>
				{/if}
			</div>
			{#if tipo !== 'smb'}
				<label class="campo">
					<span>Lock mode</span>
					<select
						name="inmutableModo"
						value={val('inmutableModo', d?.inmutable?.modo ?? 'compliance')}
					>
						<option value="compliance"
							>Compliance: nobody can delete it before the date, not even the account owner</option
						>
						<option value="governance"
							>Governance: only someone with the special permission can lift it</option
						>
					</select>
				</label>
				<p class="ayuda">
					Locking needs a bucket created with Object Lock (S3) or a container with version-level
					immutability (Azure). Then even someone with this node's credential cannot destroy the
					backups before the date: that is what protects you from ransomware. Choose more days than
					backups you keep.
				</p>
			{/if}
			<label class="campo">
				<span>State</span>
				<select name="activo" value={val('activo', d ? (d.activo ? 'si' : 'no') : 'si')}>
					<option value="si">Upload every backup</option>
					<option value="no">Paused (backups stay on this machine)</option>
				</select>
			</label>
			<div class="acciones">
				<button class="boton principal" disabled={data.soporte || !data.claveLista}>Save</button>
			</div>
		</form>
		{#if d}
			<p class="ayuda">Last changed by {d.quien}, {fechaHora(d.cambiado)}.</p>
			<form method="POST" action="?/quitar" use:enhance>
				<button class="boton peligro" disabled={data.soporte}>Remove the destination</button>
			</form>
		{/if}
	</section>
{:else}
	<section class="panel bloque">
		<h2>Restore test</h2>
		<p class="ayuda">
			Every {data.pruebaCadaDias} days the node updater downloads the latest backup from your storage
			and checks it without touching the running node: that it is byte for byte what it uploaded, that
			it is a complete age file and — only if the private backup key is on this machine — that it decrypts
			and holds the database, .env and versiones.env. With the private key kept away from this machine,
			as recommended, decryption can only be checked where you keep it:
			<code class="mono"
				>./restaurar.sh --comprobar -i /path/to/clave-copias.age &lt;backup&gt;</code
			>.
		</p>
		{#if e.prueba}
			<p class={e.prueba.resultado === 'fallo' ? 'mal' : 'bien'}>
				<b>{RESULTADO[e.prueba.resultado]}</b>, {fechaHora(e.prueba.cuando)}{#if e.prueba.nombre}
					— <code class="mono">{e.prueba.nombre}</code>{/if}.
			</p>
			<p>{e.prueba.detalle}</p>
		{:else}
			<p class="ayuda">No test yet.</p>
		{/if}
		{#if data.proximaPrueba}
			<p class="ayuda">
				Next automatic test: {data.proximaPrueba === 'pronto'
					? 'within a minute'
					: fechaHora(data.proximaPrueba)}.
			</p>
		{/if}
		{#if d?.activo}
			<form method="POST" action="?/probar" use:enhance>
				<button class="boton" disabled={d.pedidos.prueba}
					>{d.pedidos.prueba ? 'Test requested…' : 'Run a restore test now'}</button
				>
			</form>
		{/if}
	</section>
{/if}

<style>
	.cabecera {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	.intro {
		max-width: 760px;
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

	.problema {
		border-color: var(--crit);
	}

	.ayuda {
		color: var(--ink-3);
		font-size: 13px;
		margin: 8px 0 4px;
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

	code {
		overflow-wrap: anywhere;
	}

	.hash {
		word-break: break-all;
		font-size: 12px;
	}

	.tipos {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin: 12px 0 0;
		padding: 8px 12px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}

	.tipos legend {
		font-size: 12.5px;
		color: var(--ink-3);
		padding: 0 4px;
	}

	.campo {
		display: block;
		margin: 14px 0 0;
	}

	.campo span {
		display: block;
		font-size: 12.5px;
		color: var(--ink-3);
		margin-bottom: 4px;
	}

	.campo input,
	.campo select {
		width: 100%;
	}

	.dos {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 12px;
	}

	@media (max-width: 600px) {
		.dos {
			grid-template-columns: 1fr;
		}
	}

	form .boton {
		margin-top: 16px;
	}

	.acciones {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	th,
	td {
		text-align: left;
		padding: 6px 4px;
		border-bottom: 1px solid var(--line);
	}
</style>
