<script lang="ts">
	import Teaser from '$lib/Teaser.svelte';
</script>

<Teaser
	titulo="Alerts &amp; SIEM"
	intro="Send what happens on your decoys to your own tools (your SIEM, email, Teams, Slack, syslog, Microsoft Sentinel or your ticketing system) directly from your node, without ever going through SeguridadSI."
	puntos={[
		'Ready-made channels with the event already formatted: email, Microsoft Teams, Slack, Telegram, syslog, Microsoft Sentinel and tickets in Jira, ServiceNow or GLPI.',
		'Delivery rules by severity: send each destination only what matters to you.',
		'Sentinel wizard: connects your workspace without wrestling with the API.',
		'Queue with retries and health status for each output: if one does not respond, its messages wait; event intake never stops.',
		'Everything goes from the node to your tools and never passes through SeguridadSI.'
	]}
	gratis="Community already includes a raw webhook (in Settings) and CSV export of events. Formatted channels, delivery rules and retries are part of Sugardaddy Cloud."
/>
