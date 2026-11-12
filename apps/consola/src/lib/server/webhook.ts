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
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import {
	ErrorDestino,
	explicarError,
	puertoDePrueba,
	resolver,
	sinCorchetes,
	type Direccion
} from './destino-red';
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

/*
 * El POST a la dirección del cliente. El nombre se resuelve y se comprueba
 * antes (destino-red: nunca al propio nodo, a sus contenedores ni a los
 * metadatos de la nube) y se conecta a esa dirección ya comprobada, sin volver
 * a preguntar al DNS. Sin seguir redirecciones (CON-8) y sin leer el cuerpo de
 * la respuesta: solo importan el estado y, si redirige, a dónde.
 */
async function publicar(
	url: URL,
	cabeceras: Record<string, string>,
	cuerpo: string
): Promise<{ estado: number; destino?: string }> {
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new ErrorDestino('the address must start with http:// or https://');
	const dirs = await resolver(url.hostname);
	const servidor = sinCorchetes(url.hostname);
	const cifrado = url.protocol === 'https:';
	const puerto = puertoDePrueba(url.hostname) ?? (url.port ? Number(url.port) : cifrado ? 443 : 80);
	return new Promise((resolve, reject) => {
		const peticion = (cifrado ? https : http).request(
			{
				method: 'POST',
				host: servidor,
				port: puerto,
				path: `${url.pathname}${url.search}`,
				headers: {
					host: url.host,
					'content-length': String(Buffer.byteLength(cuerpo)),
					...cabeceras
				},
				...(cifrado && !isIP(servidor) ? { servername: servidor } : {}),
				lookup: (_h: string, opciones: { all?: boolean } | unknown, cb?: unknown) => {
					const f = (typeof opciones === 'function' ? opciones : cb) as (
						e: Error | null,
						a: string | Direccion[],
						fam?: number
					) => void;
					if (typeof opciones === 'object' && (opciones as { all?: boolean })?.all) f(null, dirs);
					else f(null, dirs[0].address, dirs[0].family);
				},
				agent: false,
				signal: AbortSignal.timeout(TIMEOUT_MS)
			},
			(r) => {
				const destino = r.headers.location;
				r.resume();
				resolve({ estado: r.statusCode ?? 0, ...(destino ? { destino } : {}) });
			}
		);
		peticion.on('error', reject);
		peticion.end(cuerpo);
	});
}

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
				const res = await publicar(new URL(cfg.url), cabeceras, cuerpo);
				/* Si el cliente no lo acepta (también una redirección), se para y se reintenta
				 * desde aquí en el próximo tic (no se avanza la marca de agua). */
				if (res.estado < 200 || res.estado >= 300) {
					await apuntar(
						res.estado >= 300 && res.estado < 400
							? `HTTP ${res.estado}: the receiver redirects${res.destino ? ` to ${res.destino.slice(0, 200)}` : ''}, and redirects are not followed. Put the final URL.`
							: `HTTP ${res.estado}`
					);
					return;
				}
			} catch (e) {
				/* Un destino prohibido se dice tal cual; lo demás, explicado sin la ruta. */
				let donde = 'the receiver';
				try {
					donde = new URL(cfg.url).host;
				} catch {
					/* La dirección guardada no es una URL: lo dirá el error. */
				}
				await apuntar(
					e instanceof ErrorDestino
						? `not sent: ${e.message}`
						: `no response: ${explicarError(e, donde).slice(0, 200)}`
				);
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
