<script lang="ts">
	import Teaser from '$lib/Teaser.svelte';
</script>

<Teaser
	titulo="Response"
	intro="When a decoy detects an attack, Sugardaddy can act for you: contain the attacker on your firewall, enrich the alert and run your response, with your rules and your approval. Community shows you the events; responding to them is part of Sugardaddy Cloud."
	puntos={[
		"Containment on your firewall (FortiGate): blocks the attacker's IP as soon as it touches a decoy.",
		'Rules by severity and by decoy: you decide what is contained automatically and what waits for your approval.',
		'Human approval: nothing runs without your sign-off, except what you mark as automatic.',
		'Alert enrichment before acting, so you decide with context.',
		'Queue with retries: if the firewall does not respond, the action waits and is retried.'
	]}
/>
