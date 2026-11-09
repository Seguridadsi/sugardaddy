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
import {
	eventosParaWebhook,
	guardarFalloWebhook,
	guardarWebhookPos,
	secretoWebhook,
	webhook,
	webhookPos
} from './consultas';

const TOPE = 200;
const TIMEOUT_MS = 10_000;

/* Guarda contra el solape: si un envío va lento, el siguiente tic no se mete. */
let enviando = false;
/* El último fallo apuntado, para no reescribirlo en cada tic. */
let ultimoFallo: string | null | undefined;

async function apuntar(detalle: string | null) {
	if (detalle === ultimoFallo) return;
	ultimoFallo = detalle;
	await guardarFalloWebhook(detalle ? { cuando: new Date().toISOString(), detalle } : null);
}

export async function enviarWebhookPendientes() {
	if (enviando) return;
	const cfg = await webhook();
	if (!cfg.activo || !cfg.url) return;
	const secreto = secretoWebhook(cfg);
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
			if (secreto)
				cabeceras['x-sugardaddy-firma'] =
					'sha256=' + createHmac('sha256', secreto).update(cuerpo).digest('hex');
			try {
				const res = await fetch(cfg.url, {
					method: 'POST',
					headers: cabeceras,
					body: cuerpo,
					/* Una redirección no se sigue: llevaría los eventos a otra dirección (CON-8). */
					redirect: 'manual',
					signal: AbortSignal.timeout(TIMEOUT_MS)
				});
				/* Si el cliente no lo acepta (también una redirección), se para y se reintenta
				 * desde aquí en el próximo tic (no se avanza la marca de agua). */
				if (!res.ok) {
					const destino = res.headers.get('location');
					await apuntar(
						res.status >= 300 && res.status < 400
							? `HTTP ${res.status}: the receiver redirects${destino ? ` to ${destino.slice(0, 200)}` : ''}, and redirects are not followed. Put the final URL.`
							: `HTTP ${res.status}`
					);
					return;
				}
			} catch (e) {
				await apuntar(`no response: ${String((e as Error).message ?? e).slice(0, 200)}`);
				return;
			}
			await apuntar(null);
			pos = { recibido: f.recibido.toISOString(), id: f.id };
			await guardarWebhookPos(pos);
		}
	} finally {
		enviando = false;
	}
}
