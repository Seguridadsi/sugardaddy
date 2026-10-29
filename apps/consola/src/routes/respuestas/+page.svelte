<script lang="ts">
	import Teaser from '$lib/Teaser.svelte';
</script>

<Teaser
	titulo="Respuesta"
	intro="Cuando una trampa detecta un ataque, Sugardaddy puede actuar por ti: contener al atacante en tu firewall, enriquecer el aviso y ejecutar tu respuesta, con tus reglas y tu aprobación. En la edición gratuita ves los eventos; responder a ellos es de pago."
	puntos={[
		'Contención en tu firewall (FortiGate): bloquea la IP del atacante en cuanto cae en la trampa.',
		'Reglas por severidad y por trampa: tú decides qué se contiene solo y qué espera tu aprobación.',
		'Aprobación humana: nada se ejecuta sin tu visto bueno, salvo lo que marques como automático.',
		'Enriquecimiento del aviso antes de actuar, para decidir con contexto.',
		'Cola con reintentos: si el firewall no responde, lo tuyo espera y se reintenta.'
	]}
/>
