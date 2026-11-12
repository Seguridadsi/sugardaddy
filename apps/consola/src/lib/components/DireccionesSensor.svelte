<!--
	Las direcciones de la máquina de un sensor, en poco sitio: primero la que se
	ve desde internet, si se sabe (lib/server/ip-publica-sensor.ts), con su
	etiqueta; las demás, plegadas cuando son muchas. Un sensor de internet con
	diez direcciones internas no llena la fila ni se confunde con otro que tenga
	las mismas diez en su propia red.
-->
<script lang="ts">
	let { ips, ipPublica = null }: { ips: readonly string[]; ipPublica?: string | null } = $props();

	/* Sin plegar caben estas; con una más ya se pliegan todas tras la primera. */
	const A_LA_VISTA = 2;
	const resto = $derived(ips.filter((x) => x !== ipPublica));
	const plegar = $derived(resto.length > A_LA_VISTA);
	/* Sin dirección pública, la primera de la máquina queda a la vista. */
	const primera = $derived(!ipPublica && plegar ? resto[0] : null);
	const plegadas = $derived(primera ? resto.slice(1) : resto);
	const que = $derived(ipPublica ? 'internal' : 'more');
</script>

{#if ipPublica}
	<span class="linea mono" title="The address this sensor is seen from on the internet"
		><b>{ipPublica}</b> <small>public address</small></span
	>
{/if}
{#if primera}
	<span class="linea mono" title="An IP address of the sensor machine"><b>{primera}</b></span>
{/if}
{#if plegar}
	<details>
		<summary
			>+{plegadas.length}
			{que}
			{plegadas.length === 1 ? 'address' : 'addresses'}</summary
		>
		<span class="mono lista">{plegadas.join(' · ')}</span>
	</details>
{:else if resto.length}
	<span class="linea mono" class:fuerte={!ipPublica} title="The IP addresses of the sensor machine"
		>{resto.join(' · ')}</span
	>
{/if}

<style>
	.linea {
		display: block;
		margin-bottom: 2px;
	}

	.fuerte {
		font-weight: 600;
	}

	small {
		font-family: var(--font-body);
		font-size: 11.5px;
		color: var(--ink-3);
	}

	details {
		margin-bottom: 2px;
	}

	summary {
		cursor: pointer;
		width: max-content;
		font-size: 12px;
		color: var(--ink-2);
	}

	.lista {
		display: block;
		margin-top: 2px;
		font-size: 12px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}
</style>
