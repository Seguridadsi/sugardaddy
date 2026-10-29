/*
 * Worker del WEBHOOK de eventos (edición community). Cada poco, si está activo,
 * dispara los eventos nuevos (desde la marca de agua) a la URL del cliente, tal
 * cual: el JSON firmado del sensor. Best-effort y SIN garantías —si el endpoint
 * no contesta, se reintenta desde el mismo punto en el siguiente tic—; la
 * fiabilidad (reglas, reintentos persistentes, formato por canal, respuesta
 * automática) es la edición de pago (Avisos y SIEM). Desacoplado de la ingesta:
 * no toca el camino crítico del sensor, así que no puede tumbar la entrada de
 * eventos; solo lee lo ya guardado.
 */
import { createHmac } from 'node:crypto';
import { eventosParaWebhook, guardarWebhookPos, webhook, webhookPos } from './consultas';

const TOPE = 200;
const TIMEOUT_MS = 10_000;

/* Guarda contra el solape: si un envío va lento, el siguiente tic no se mete. */
let enviando = false;

export async function enviarWebhookPendientes() {
	if (enviando) return;
	const cfg = await webhook();
	if (!cfg.activo || !cfg.url) return;
	enviando = true;
	try {
		let pos = await webhookPos();
		const filas = await eventosParaWebhook(pos, TOPE);
		for (const f of filas) {
			let cuerpo;
			try {
				cuerpo = f.linea; /* ya es el JSON del evento, se manda tal cual */
				JSON.parse(f.linea); /* comprobación: si no es JSON, se envuelve */
			} catch {
				cuerpo = JSON.stringify({ linea: f.linea });
			}
			const cabeceras: Record<string, string> = { 'content-type': 'application/json' };
			if (cfg.secreto)
				cabeceras['x-sugardaddy-firma'] =
					'sha256=' + createHmac('sha256', cfg.secreto).update(cuerpo).digest('hex');
			try {
				const res = await fetch(cfg.url, {
					method: 'POST',
					headers: cabeceras,
					body: cuerpo,
					signal: AbortSignal.timeout(TIMEOUT_MS)
				});
				/* Si el cliente no lo acepta, se para y se reintenta desde aquí en el
				 * próximo tic (no se avanza la marca de agua). */
				if (!res.ok) return;
			} catch {
				return;
			}
			pos = { recibido: f.recibido.toISOString(), id: f.id };
			await guardarWebhookPos(pos);
		}
	} finally {
		enviando = false;
	}
}
