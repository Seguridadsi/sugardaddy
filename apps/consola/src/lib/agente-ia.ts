/*
 * Un honeypot puede decir que quien lo toca es un agente de IA: lleva una nota
 * que solo un agente lee y sigue, y marca el evento con `agente_ia` en su
 * detalle (modulos/trampas/login-web/imagen/fuente/agente.go). «suspected»: ha
 * pedido la página a la que apunta la nota. «confirmed»: además ha hecho lo que
 * esa página pide. El detalle lo escribe el honeypot, no el atacante.
 *
 * Las trampas web reconocen además a algunas herramientas por cómo se portan
 * (reto_agentes.go): tras un reto falso de Cloudflare (CyberStrike, PentestCode,
 * «confirmed») o por la doble carga de una página (PentAGI, «suspected»). Lo
 * dicen en `herramienta_ia`, y eso es lo que se enseña en vez de la nota.
 */
export type AgenteIa = 'suspected' | 'confirmed';

export function agenteIaDe(detalle: Record<string, unknown> | null | undefined): AgenteIa | null {
	const v = detalle?.agente_ia;
	return v === 'suspected' || v === 'confirmed' ? v : null;
}

export const ETIQUETA_AGENTE: Record<AgenteIa, string> = {
	suspected: 'AI agent?',
	confirmed: 'AI agent'
};

export const QUE_ES_AGENTE: Record<AgenteIa, string> = {
	suspected:
		'This honeypot carries a note only an AI agent reads. Whoever sent this request asked for the page that note points to: probably an attacker driving an AI agent, or a person reading the page source.',
	confirmed:
		'This honeypot carries a note only an AI agent reads. Whoever sent this request read it and did what it asked: the attacker is using an AI agent.'
};

/* El nombre de la herramienta que reconoce el honeypot, si lo da. */
export function herramientaIaDe(detalle: Record<string, unknown> | null | undefined): string {
	const v = detalle?.herramienta_ia;
	return typeof v === 'string' ? v.trim().slice(0, 80) : '';
}

/* La etiqueta corta del evento: con el nombre de la herramienta si lo hay. */
export function etiquetaAgente(detalle: Record<string, unknown> | null | undefined): string | null {
	const v = agenteIaDe(detalle);
	if (!v) return null;
	const h = herramientaIaDe(detalle);
	return h ? `${ETIQUETA_AGENTE[v]}${v === 'confirmed' ? ':' : ''} ${h}` : ETIQUETA_AGENTE[v];
}

/* La explicación del evento: la de la nota, o la de la herramienta reconocida. */
export function queEsAgente(detalle: Record<string, unknown> | null | undefined): string | null {
	const v = agenteIaDe(detalle);
	if (!v) return null;
	const h = herramientaIaDe(detalle);
	if (!h) return QUE_ES_AGENTE[v];
	return v === 'confirmed'
		? `The honeypot recognised ${h} by how it behaves, not by what it says about itself: the attacker is using that AI agent.`
		: `This request behaves the way ${h} does. A hint, not proof: it could also be a person or another tool.`;
}
