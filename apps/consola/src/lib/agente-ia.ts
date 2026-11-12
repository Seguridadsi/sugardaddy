/*
 * Un honeypot puede decir que quien lo toca es un agente de IA: lleva una nota
 * que solo un agente lee y sigue, y marca el evento con `agente_ia` en su
 * detalle (modulos/trampas/login-web/imagen/fuente/agente.go). «suspected»: ha
 * pedido la página a la que apunta la nota. «confirmed»: además ha hecho lo que
 * esa página pide. El detalle lo escribe el honeypot, no el atacante.
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
