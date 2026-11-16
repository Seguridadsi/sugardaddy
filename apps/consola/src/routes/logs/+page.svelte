<script lang="ts">
	import { page } from '$app/state';
	import { diaCorto, horaCorta } from '$lib/fechas-pantalla';
	import Pestanas from '$lib/components/Pestanas.svelte';
	import { pestanaDe } from '$lib/pestanas';

	let { data } = $props();

	const PESTANAS = [
		{ id: 'entries', texto: 'All entries' },
		{ id: 'support', texto: 'Support sessions' }
	] as const;
	const pestana = $derived(pestanaDe(page.url, PESTANAS));

	/* Lo de una misma entrada del soporte, junto: la sesión, quién, de cuándo a cuándo y qué hizo. */
	const sesiones = $derived.by(() => {
		const grupos: {
			clave: string;
			quien: string;
			desde: string;
			hasta: string;
			filas: typeof data.soporte;
		}[] = [];
		for (const f of data.soporte) {
			const clave = f.sesion ?? `sin-sesion-${f.quien}`;
			let g = grupos.find((x) => x.clave === clave);
			if (!g) {
				g = { clave, quien: f.quien, desde: f.cuando, hasta: f.cuando, filas: [] };
				grupos.push(g);
			}
			g.filas.push(f);
			if (f.cuando < g.desde) g.desde = f.cuando;
			if (f.cuando > g.hasta) g.hasta = f.cuando;
		}
		return grupos;
	});
	const accionTexto = (f: (typeof data.soporte)[number]) =>
		f.metodo === 'GET' || f.metodo === 'HEAD' ? 'Viewed' : 'Action';
	const detalle = (d: Record<string, unknown>) =>
		Object.entries(d)
			.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
			.join(' · ');
</script>

<svelte:head>
	<title>Audit logs — Sugardaddy</title>
</svelte:head>

<div class="cabecera">
	<div>
		<h1>Audit logs</h1>
	</div>
	{#if pestana === 'entries'}
		<form method="GET">
			<input name="q" value={data.q} placeholder="Search: email, action, IP…" />
		</form>
	{/if}
</div>

<Pestanas pestanas={PESTANAS} actual={pestana} etiqueta="Audit log sections" />

{#if pestana === 'support'}
	<p class="nota arriba">
		Everything {data.operador} support did in this console while you had support access open: every page
		they opened and every action they took, with the answer the console gave. The content of forms is
		never recorded. Actions also appear in All entries, and both reach your SIEM (<code
			>auditoria.soporte-accion</code
		>, <code>auditoria.soporte-peticion</code>).
	</p>
	{#each sesiones as g (g.clave)}
		<section class="panel sesion">
			<h2>
				{g.quien}
				<small class="mono"
					>{diaCorto(g.desde)}
					{horaCorta(g.desde)} – {horaCorta(g.hasta)} · {g.filas.length}
					{g.filas.length === 1 ? 'request' : 'requests'}</small
				>
			</h2>
			<ul>
				{#each g.filas as f (f.id)}
					<li class="grabacion">
						<span class="cuando mono">{horaCorta(f.cuando)}</span>
						<span class={f.metodo === 'GET' || f.metodo === 'HEAD' ? 'quien' : 'accion'}
							>{accionTexto(f)}</span
						>
						<span class="detalle mono" title={f.ruta}
							>{f.metodo} {f.ruta}{f.accion ? ` ?/${f.accion}` : ''}</span
						>
						<span class="estado mono">{f.estado}</span>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<section class="panel"><p class="vacio">Support has not signed in to this console.</p></section>
	{/each}
{:else}
	<section class="panel">
		<ul>
			{#each data.filas as a (a.id)}
				<li>
					<span class="cuando mono">{diaCorto(a.cuando)} {horaCorta(a.cuando)}</span>
					<span class="quien">{a.quien}</span>
					<span class="accion">{a.accion}</span>
					<span class="detalle mono" title={detalle(a.detalle)}>{detalle(a.detalle)}</span>
				</li>
			{:else}
				<li class="vacio">No matches.</li>
			{/each}
		</ul>
	</section>
{/if}
<p class="nota">
	Audit logs are append-only: nobody, including {data.operador}, can delete entries from the
	console.
</p>

<style>
	.cabecera {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 18px;
	}

	h1 {
		font-size: clamp(24px, 5vw, 32px);
		font-weight: 700;
		margin-top: 3px;
	}

	.cabecera form {
		min-width: 280px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: grid;
		grid-template-columns: 120px minmax(120px, 1fr) minmax(140px, 1fr) minmax(0, 2fr);
		gap: 14px;
		padding: 10px 17px;
		border-bottom: 1px solid var(--line);
		font-size: 13px;
		align-items: baseline;
	}

	li:last-child {
		border-bottom: none;
	}

	.cuando {
		font-size: 12px;
		color: var(--ink-3);
	}

	.quien {
		color: var(--ink-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.accion {
		font-weight: 600;
	}

	.detalle {
		font-size: 11.5px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sesion {
		margin-bottom: 14px;
	}

	.sesion h2 {
		font-size: 14px;
		font-weight: 600;
		padding: 12px 17px 0;
	}

	.sesion h2 small {
		display: block;
		font-weight: 400;
		font-size: 12px;
		color: var(--ink-3);
		margin-top: 2px;
	}

	li.grabacion {
		grid-template-columns: 70px 70px minmax(0, 1fr) 50px;
	}

	.estado {
		font-size: 12px;
		color: var(--ink-3);
		text-align: right;
	}

	.nota.arriba {
		margin: 0 2px 14px;
	}

	.vacio {
		display: block;
		color: var(--ink-2);
		text-align: center;
		padding: 24px;
	}

	.nota {
		font-size: 12.5px;
		color: var(--ink-3);
		margin: 12px 2px 0;
	}

	@media (max-width: 1008px) {
		li {
			grid-template-columns: minmax(0, 1fr);
			gap: 2px;
		}
	}
</style>
