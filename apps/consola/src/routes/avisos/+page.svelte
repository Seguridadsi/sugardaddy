<script lang="ts">
	import Teaser from '$lib/Teaser.svelte';
</script>

<Teaser
	titulo="Avisos y SIEM"
	intro="Lleva lo que pasa en tus trampas a tus herramientas —tu SIEM, tu correo, Teams, Slack, syslog o Microsoft Sentinel— directamente desde tu nodo y sin pasar nunca por SeguridadSI."
	puntos={[
		'Canales listos con el evento ya formateado: correo, Microsoft Teams, Slack, syslog y Microsoft Sentinel.',
		'Reglas de envío por severidad: manda a cada sitio solo lo que te importa.',
		'Asistente de Sentinel: te deja el workspace conectado sin pelearte con la API.',
		'Cola con reintentos y salud de cada salida: si una no responde, lo suyo espera; la recepción nunca se para.',
		'Todo sale del nodo hacia tus herramientas y nunca pasa por SeguridadSI.'
	]}
	gratis="Gratis ya tienes un webhook en crudo (en Ajustes) y exportar los eventos a CSV. Los canales con formato, las reglas de envío y los reintentos son de pago."
/>
